import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import type { Subject } from '@taskflow/policy';
import {
  asc,
  closeDatabase,
  initializeAuditDatabase,
  initializeDatabase,
  schema,
  withOrgScope,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from './org.service.js';
import * as members from './member.service.js';
import * as teams from './team.service.js';
import * as grants from './grant.service.js';
import * as memberGrants from './member-grant.service.js';
import * as authz from './authz.service.js';
import * as audit from './audit.service.js';
import { drainOutboxFully } from './audit.projection.js';
import { loadMemberGrants, loadTuples, resolveOrgMembership } from './resolve.js';
import { can } from '@taskflow/policy';

/**
 * The tenancy slice, end to end, against real Postgres (`docker compose up -d`).
 *
 * "Tests ship with the slice. A slice with untested authorization is not done."
 * The properties asserted here are the ones only a real execution demonstrates:
 * an org created and entered in one transaction, a last-owner demotion refused
 * by a check that runs inside the write's own transaction, a tuple granted to a
 * team arriving at the policy engine attached to a person, and an audit chain
 * that notices a row edited behind its back.
 */

const AUDIT_URL =
  process.env['TEST_DATABASE_AUDIT_URL'] ??
  'postgresql://taskflow_audit:audit-dev-secret@localhost:5433/taskflow_test';

const OWNER = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-000000000001');
const COLLEAGUE = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-000000000002');
const OUTSIDER = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-000000000003');
/* The one fixture user with NO verified email — the org-creation gate
   (Phase 12 Wave 1 §3.4) must refuse them while everyone above passes. */
const UNVERIFIED = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-000000000004');
const BOARD = '0195dd00-0000-7000-8000-0000000000bb';

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@tenancy.test'],
  [COLLEAGUE, 'colleague@tenancy.test'],
  [OUTSIDER, 'outsider@tenancy.test'],
  [UNVERIFIED, 'unverified@tenancy.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195dd00-0000-7000-8000-0000000000ff');
const actorOf = (userId: UserId): { userId: UserId; requestId: RequestId } => ({
  userId,
  requestId,
});

let admin: AdminConnection;
/** Every org created during a test, torn down afterwards. */
let created: OrgId[] = [];

async function newOrg(slug: string, owner: UserId = OWNER): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, actorOf(owner));
  created.push(result.orgId);
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM audit.audit_log WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM audit.chain_heads WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.member_grants WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.team_members WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.teams WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  for (const [id, email] of USERS) {
    if (id === UNVERIFIED) continue;
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }
  /* UNVERIFIED deliberately gets NO `email_verified_at` — the org-creation
     gate exists to refuse exactly that row. */
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized) VALUES ($1, $2, $2)`,
    [UNVERIFIED, 'unverified@tenancy.test'],
  );

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-tenancy-svc-test' });
  initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-tenancy-svc-audit' });
});

/* Torn down before each test rather than after, so a failing test leaves its
   rows in the database to inspect. */
beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
});

describe('creating an organization', () => {
  it('makes the creator its owner, atomically', async () => {
    const orgId = await newOrg('acme-one');

    // An org with no membership row is unreachable by anyone, including its
    // creator — every route needs a membership to resolve a role. So the two
    // writes are one transaction, and this is what proves it.
    const membership = await resolveOrgMembership(OWNER, orgId);
    expect(membership?.role).toBe('owner');
  });

  it('refuses a slug that is already taken', async () => {
    await newOrg('acme-two');
    await expect(
      orgs.createOrg({ name: 'Impostor', slug: 'acme-two' }, actorOf(COLLEAGUE)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('emits org.created into the outbox in the same transaction', async () => {
    const orgId = await newOrg('acme-three');

    /* `orderBy(asc(id))` is load-bearing, not tidiness. `outbox.id` is a
       UUIDv7 (`appendToOutbox` writes `event.id` from `newId()`), and
       `uuidv7()` keeps a module-level counter that makes ids strictly
       increasing even within one millisecond (packages/security/src/uuid.ts)
       — so generation order is genuinely encoded in the id and this ORDER BY
       is exact, not a heuristic. Without it, Postgres is free to return the
       two rows in either physical order, and CI proved it will: this test
       failed intermittently on an unordered SELECT before this fix. */
    const rows = await withOrgScope(orgId, async (tx) =>
      tx.select({ name: schema.outbox.name }).from(schema.outbox).orderBy(asc(schema.outbox.id)),
    );
    // billing.trial_started (Phase 12 Wave 3) writes to the SAME outbox
    // append call, alongside org.created — one org creation, two events.
    expect(rows).toEqual([{ name: 'org.created' }, { name: 'billing.trial_started' }]);
  });

  it('refuses an account that has not verified its email', async () => {
    /* Phase 12 Wave 1 §3.4: self-serve creation is the abuse surface the gate
       exists for, so the precondition is on the ACTOR, checked before the
       transaction opens — an unverified account must not even get as far as
       minting an org id. */
    await expect(
      orgs.createOrg({ name: 'No Verify', slug: 'no-verify' }, actorOf(UNVERIFIED)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('settings capabilities', () => {
  /* getOrg's capabilities exist so the Settings page can hide a control an
     unusable route backs, without the frontend re-deriving the permission
     matrix — see org.service.ts's own comment. This asserts the SAME thing
     the route asserts (can()), through the one function the route calls, so
     a drift between "what capabilities says" and "what the mutation actually
     allows" would show up here. */
  it("reports what the caller's own role permits, not what any button assumes", async () => {
    const orgId = await newOrg('capabilities-one');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );

    const ownerSubject: Subject = { orgId, userId: OWNER, role: 'owner', tuples: [] };
    const memberSubject: Subject = { orgId, userId: COLLEAGUE, role: 'member', tuples: [] };

    const asOwner = await orgs.getOrg(orgId, ownerSubject);
    const asMember = await orgs.getOrg(orgId, memberSubject);

    expect(asOwner.capabilities).toEqual({
      updateOrg: true,
      inviteMember: true,
      manageMembers: true,
      viewDirectory: true,
      removeMembers: true,
      manageTeams: true,
      viewTeams: true,
      createProject: true,
      viewAnalytics: true,
      viewAuditLog: true,
      readPhoneNumbers: true,
      placeCalls: true,
      readCalls: true,
      sendSms: true,
      readSms: true,
      manageAutomations: true,
      manageWebhooks: true,
      manageIntegrations: true,
      createApiTokens: true,
      revokeApiTokens: true,
      viewBilling: true,
      purchaseNumbers: true,
      releaseNumbers: true,
      manageSavedSearches: true,
      readRecordings: true,
      createSpace: true,
      useAi: true,
      createBranches: true,
    });

    // A plain Member holds none of these — card:create and friends do not
    // touch org, member, team, project, analytics, automation, billing, or
    // audit administration at all, and (Phase 15 §1) the telephony five and
    // (Wave 2) the five automation permissions are no longer role defaults
    // either: this Member has no `authz.member_grants` row, so all ten read
    // false too. `viewDirectory`/`viewTeams` are the two exceptions: a
    // Member holds `member:read`/`team:read` directly by role
    // (`packages/policy/src/roles.ts`'s `MEMBER` array), the same
    // permissions that gate `/people` and the Settings page's members/team
    // lists — only Guest, whose role grants nothing at all, reads either
    // one false too.
    expect(asMember.capabilities).toEqual({
      updateOrg: false,
      inviteMember: false,
      manageMembers: false,
      viewDirectory: true,
      removeMembers: false,
      manageTeams: false,
      viewTeams: true,
      createProject: false,
      viewAnalytics: false,
      viewAuditLog: false,
      readPhoneNumbers: false,
      placeCalls: false,
      readCalls: false,
      sendSms: false,
      readSms: false,
      manageAutomations: false,
      manageWebhooks: false,
      manageIntegrations: false,
      createApiTokens: false,
      revokeApiTokens: false,
      viewBilling: false,
      purchaseNumbers: false,
      releaseNumbers: false,
      manageSavedSearches: false,
      readRecordings: false,
      createSpace: false,
      useAi: false,
      createBranches: false,
    });
  });

  it('gives an Admin invite/team capabilities but not the Owner-only ones', async () => {
    /* The role matrix's own asymmetry (packages/policy/src/roles.ts): Admin
       gets member:invite and team:manage, but org:update, member:manage,
       member:remove, org:billing, and phoneNumber:purchase/release stay
       Owner-only — Admin holds phoneNumber:read (below) but not the two
       that spend money or give a number up. A capabilities object that
       collapsed these into one "isAdmin" flag would be wrong for exactly
       this role. */
    const orgId = await newOrg('capabilities-two');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'admin' },
      actorOf(OWNER),
    );

    const adminSubject: Subject = { orgId, userId: COLLEAGUE, role: 'admin', tuples: [] };
    const result = await orgs.getOrg(orgId, adminSubject);

    expect(result.capabilities).toEqual({
      updateOrg: false,
      inviteMember: true,
      manageMembers: false,
      viewDirectory: true,
      removeMembers: false,
      manageTeams: true,
      viewTeams: true,
      createProject: true,
      viewAnalytics: true,
      viewAuditLog: true,
      readPhoneNumbers: true,
      placeCalls: true,
      readCalls: true,
      sendSms: true,
      readSms: true,
      manageAutomations: true,
      manageWebhooks: true,
      manageIntegrations: true,
      createApiTokens: true,
      revokeApiTokens: true,
      viewBilling: false,
      purchaseNumbers: false,
      releaseNumbers: false,
      manageSavedSearches: true,
      readRecordings: true,
      createSpace: true,
      useAi: true,
      createBranches: true,
    });
  });

  it('reflects an individual automation grant, and only that one permission', async () => {
    /* Wave 2 (ai/phase-15-ai-copilot-and-permissions.md §1): a Member can
       now be granted one of the four automation permissions individually,
       the same mechanism telephony already used. `getOrg`'s capabilities
       must show EXACTLY the one granted, not "has automation access" as a
       single flag — someone with only webhook:manage still cannot build
       rules or connect an integration. */
    const orgId = await newOrg('capabilities-automation-grant');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );
    await memberGrants.grant(
      orgId,
      { userId: COLLEAGUE, permission: 'webhook:manage' },
      actorOf(OWNER),
    );

    const memberSubject: Subject = {
      orgId,
      userId: COLLEAGUE,
      role: 'member',
      tuples: [],
      memberGrants: ['webhook:manage'],
    };
    const result = await orgs.getOrg(orgId, memberSubject);

    expect(result.capabilities.manageWebhooks).toBe(true);
    expect(result.capabilities.manageAutomations).toBe(false);
    expect(result.capabilities.manageIntegrations).toBe(false);
    expect(result.capabilities.createApiTokens).toBe(false);
    expect(result.capabilities.revokeApiTokens).toBe(false);
  });
});

describe('the org switcher', () => {
  it('lists every org the caller belongs to, and no others', async () => {
    const first = await newOrg('switch-one');
    const second = await newOrg('switch-two');
    await newOrg('switch-other', COLLEAGUE);

    const mine = await orgs.listMyOrgs(OWNER);
    expect(mine.map((org) => org.orgId).sort()).toEqual([first, second].sort());
    expect(mine.every((org) => org.membershipStatus === 'active')).toBe(true);
  });

  it('shows nothing to someone who belongs to no org', async () => {
    await newOrg('switch-three');
    expect(await orgs.listMyOrgs(OUTSIDER)).toEqual([]);
  });

  /* The read half of the fix `resolveOrgMembership`'s own suspension test
     proves for the write side: a suspended row must still be REPORTED here,
     not filtered out, or the caller (OrgGate, the picker) has no way to tell
     "you have no access here any more" apart from "you were never here" —
     see org.service.ts's own header on `listMyOrgs`. */
  it('reports a suspended membership rather than omitting it', async () => {
    const orgId = await newOrg('switch-suspended');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );

    await admin.setOrg(orgId);
    await admin.query(
      `UPDATE identity.memberships SET status = 'suspended' WHERE org_id = $1 AND user_id = $2`,
      [orgId, COLLEAGUE],
    );
    await admin.setOrg(null);

    const mine = await orgs.listMyOrgs(COLLEAGUE);
    expect(mine).toEqual([expect.objectContaining({ orgId, membershipStatus: 'suspended' })]);
  });

  /* The identical gap one level up: `resolveOrgMembership` has answered a
     suspended ORG with a distinct `ORG_SUSPENDED` since before this field
     existed, but with no `orgStatus` reported here, neither the picker nor
     `OrgGate` had anything to check — a suspended org read as an ordinary
     one right up until the first org-scoped query after choosing it threw
     an error nothing on either surface was built to catch. */
  it("reports the org's own suspension, distinct from the membership's", async () => {
    const orgId = await newOrg('switch-org-suspended');

    await admin.setOrg(orgId);
    await admin.query(`UPDATE identity.orgs SET status = 'suspended' WHERE id = $1`, [orgId]);
    await admin.setOrg(null);

    const mine = await orgs.listMyOrgs(OWNER);
    expect(mine).toEqual([
      expect.objectContaining({ orgId, membershipStatus: 'active', orgStatus: 'suspended' }),
    ]);
  });

  it('omits a deleted org entirely, the same privacy answer resolveOrgMembership gives', async () => {
    const orgId = await newOrg('switch-org-deleted');

    await admin.setOrg(orgId);
    await admin.query(`UPDATE identity.orgs SET status = 'deleted' WHERE id = $1`, [orgId]);
    await admin.setOrg(null);

    expect(await orgs.listMyOrgs(OWNER)).toEqual([]);
  });
});

describe('resolving the org from a request', () => {
  it('refuses an org the caller is not a member of', async () => {
    // The header naming the org is attacker-controlled. It selects a membership
    // row and never becomes one — so naming someone else's org resolves to
    // nothing, and every permission-bearing route then answers NOT_A_MEMBER.
    const orgId = await newOrg('resolve-one');
    expect(await resolveOrgMembership(OUTSIDER, orgId)).toBeNull();
  });

  it('refuses a malformed org id without touching the database', async () => {
    expect(await resolveOrgMembership(OWNER, 'not-a-uuid')).toBeNull();
  });

  it('reflects a demotion immediately, not when the token expires', async () => {
    /* The reason the role is read per request rather than carried in the access
       token. With a claim, this assertion could only pass after the token's ten
       minutes elapsed — which is exactly the window that matters. */
    const orgId = await newOrg('resolve-two');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'admin' },
      actorOf(OWNER),
    );

    expect((await resolveOrgMembership(COLLEAGUE, orgId))?.role).toBe('admin');

    await members.changeRole(orgId, { userId: COLLEAGUE, role: 'member' }, actorOf(OWNER));
    expect((await resolveOrgMembership(COLLEAGUE, orgId))?.role).toBe('member');
  });
});

describe('membership management', () => {
  it('adds an existing user', async () => {
    const orgId = await newOrg('member-one');
    const added = await members.addMember(
      orgId,
      { email: 'Colleague@Tenancy.Test', role: 'member' },
      actorOf(OWNER),
    );
    expect(added.userId).toBe(COLLEAGUE);
  });

  it('answers the same for an unknown address as for any other failure', async () => {
    // Otherwise this endpoint tells an admin of any org whether a given email
    // has an account here (§8.7).
    const orgId = await newOrg('member-two');
    await expect(
      members.addMember(orgId, { email: 'nobody@tenancy.test', role: 'member' }, actorOf(OWNER)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('will not hand out owner directly', async () => {
    const orgId = await newOrg('member-three');
    await expect(
      members.addMember(orgId, { email: 'colleague@tenancy.test', role: 'owner' }, actorOf(OWNER)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses to let anyone change their own role', async () => {
    // Self-promotion is the shape almost every privilege-escalation bug takes,
    // and there is no legitimate use for it.
    const orgId = await newOrg('member-four');
    await expect(
      members.changeRole(orgId, { userId: OWNER, role: 'member' }, actorOf(OWNER)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses to demote the last owner', async () => {
    /* An org with no owner is one nobody can administer, recover, or delete —
       the only fix is a database console. */
    const orgId = await newOrg('member-five');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'admin' },
      actorOf(OWNER),
    );

    await expect(
      members.changeRole(orgId, { userId: OWNER, role: 'member' }, actorOf(COLLEAGUE)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses to remove the last owner', async () => {
    const orgId = await newOrg('member-six');
    await expect(
      members.removeMember(orgId, { userId: OWNER }, actorOf(COLLEAGUE)),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('allows demoting an owner once a second one exists', async () => {
    const orgId = await newOrg('member-seven');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'admin' },
      actorOf(OWNER),
    );
    await members.changeRole(orgId, { userId: COLLEAGUE, role: 'owner' }, actorOf(OWNER));

    const change = await members.changeRole(
      orgId,
      { userId: OWNER, role: 'member' },
      actorOf(COLLEAGUE),
    );
    expect(change).toEqual({ from: 'owner', to: 'member' });
  });

  it('withdraws per-resource grants when a member is removed', async () => {
    /* Otherwise re-adding the person silently restores every grant they had —
       access nobody re-granted and no event records. */
    const orgId = await newOrg('member-eight');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );
    await grants.grant(
      orgId,
      {
        subjectType: 'user',
        subjectId: COLLEAGUE,
        relation: 'editor',
        objectType: 'board',
        objectId: BOARD,
        expiresAt: null,
      },
      actorOf(OWNER),
    );

    expect(await loadTuples(orgId, COLLEAGUE)).toHaveLength(1);

    await members.removeMember(orgId, { userId: COLLEAGUE }, actorOf(OWNER));
    expect(await loadTuples(orgId, COLLEAGUE)).toHaveLength(0);
  });

  describe('startOffboarding (ai/phase-15-ai-copilot-and-permissions.md §8)', () => {
    it('writes an event and nothing else — the membership is untouched', async () => {
      const orgId = await newOrg('offboarding-one');
      await members.addMember(
        orgId,
        { email: 'colleague@tenancy.test', role: 'member' },
        actorOf(OWNER),
      );

      const result = await members.startOffboarding(orgId, { userId: COLLEAGUE }, actorOf(OWNER));
      expect(result).toEqual({ started: true });

      // Still an ordinary, active member — only `removeMember` ends that.
      const roster = await members.listMembers(orgId);
      expect(roster.find((member) => member.userId === COLLEAGUE)?.status).toBe('active');

      await drainOutboxFully();
      const entries = await audit.listAuditEntries(orgId, { limit: 50, before: null });
      expect(entries[0]).toMatchObject({ action: 'member.offboarding_started' });
    });

    it('can be called more than once — there is no state here a second call could corrupt', async () => {
      const orgId = await newOrg('offboarding-two');
      await members.addMember(
        orgId,
        { email: 'colleague@tenancy.test', role: 'member' },
        actorOf(OWNER),
      );

      await members.startOffboarding(orgId, { userId: COLLEAGUE }, actorOf(OWNER));
      await expect(
        members.startOffboarding(orgId, { userId: COLLEAGUE }, actorOf(OWNER)),
      ).resolves.toEqual({ started: true });
    });

    it('404s for someone who was never a member here', async () => {
      const orgId = await newOrg('offboarding-three');
      await expect(
        members.startOffboarding(orgId, { userId: OUTSIDER }, actorOf(OWNER)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});

describe('the tuple loader', () => {
  it('expands a team grant into the members of that team', async () => {
    /* The reason the policy engine can stay pure. A tuple naming a team arrives
       here, and leaves naming a person — the engine never learns teams exist. */
    const orgId = await newOrg('tuple-one');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );

    const { teamId } = await teams.createTeam(
      orgId,
      { name: 'Platform', slug: 'platform' },
      actorOf(OWNER),
    );
    await teams.addTeamMember(orgId, { teamId, userId: COLLEAGUE }, actorOf(OWNER));

    await grants.grant(
      orgId,
      {
        subjectType: 'team',
        subjectId: teamId,
        relation: 'editor',
        objectType: 'board',
        objectId: BOARD,
        expiresAt: null,
      },
      actorOf(OWNER),
    );

    const tuples = await loadTuples(orgId, COLLEAGUE);
    expect(tuples).toEqual([
      { subject: COLLEAGUE, relation: 'editor', object: { type: 'board', id: BOARD } },
    ]);
  });

  it('drops a grant the moment it expires, without waiting for a sweep', async () => {
    const orgId = await newOrg('tuple-two');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );

    const soon = new Date(Date.now() + 60_000).toISOString();
    const { tupleId } = await grants.grant(
      orgId,
      {
        subjectType: 'user',
        subjectId: COLLEAGUE,
        relation: 'viewer',
        objectType: 'board',
        objectId: BOARD,
        expiresAt: soon,
      },
      actorOf(OWNER),
    );

    expect(await loadTuples(orgId, COLLEAGUE)).toHaveLength(1);

    // Move the expiry into the past. The loader's WHERE clause is the whole
    // enforcement — there is no job whose schedule could delay this.
    await admin.setOrg(orgId);
    await admin.query(
      `UPDATE authz.relationship_tuples SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [tupleId],
    );
    await admin.setOrg(null);

    expect(await loadTuples(orgId, COLLEAGUE)).toHaveLength(0);
  });

  it('refuses a grant to someone outside the organization', async () => {
    const orgId = await newOrg('tuple-three');
    await expect(
      grants.grant(
        orgId,
        {
          subjectType: 'user',
          subjectId: OUTSIDER,
          relation: 'editor',
          objectType: 'board',
          objectId: BOARD,
          expiresAt: null,
        },
        actorOf(OWNER),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is idempotent, so a repeated grant does not change the capping arithmetic', async () => {
    /* The engine caps a subject when EVERY tuple at the nearest distance is
       restrictive. A duplicate viewer row must not affect that count. */
    const orgId = await newOrg('tuple-four');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );

    const input = {
      subjectType: 'user' as const,
      subjectId: COLLEAGUE,
      relation: 'viewer',
      objectType: 'board',
      objectId: BOARD,
      expiresAt: null,
    };
    const first = await grants.grant(orgId, input, actorOf(OWNER));
    const second = await grants.grant(orgId, input, actorOf(OWNER));

    expect(second.tupleId).toBe(first.tupleId);
    expect(await loadTuples(orgId, COLLEAGUE)).toHaveLength(1);
  });
});

describe('the permission debug surface', () => {
  it('explains a grant through the role', async () => {
    const orgId = await newOrg('explain-one');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );

    const result = await authz.explain(orgId, {
      userId: COLLEAGUE,
      permission: 'card:create',
      resourceType: null,
      resourceId: null,
    });

    expect(result.allowed).toBe(true);
    expect(result.role).toBe('member');
    expect(result.formatted).toContain('allow  card:create');
  });

  it('explains a denial caused by a read-only tuple overriding the role', async () => {
    /* The exact case §8.2 illustrates: a member whose role grants card:update is
       still denied on a board where they are only a viewer. Sharing a board
       read-only must not silently confer write access. */
    const orgId = await newOrg('explain-two');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );
    await grants.grant(
      orgId,
      {
        subjectType: 'user',
        subjectId: COLLEAGUE,
        relation: 'viewer',
        objectType: 'board',
        objectId: BOARD,
        expiresAt: null,
      },
      actorOf(OWNER),
    );

    const result = await authz.explain(orgId, {
      userId: COLLEAGUE,
      permission: 'board:update',
      resourceType: 'board',
      resourceId: BOARD,
    });

    expect(result.allowed).toBe(false);
    expect(result.formatted).toContain('read-only');
    expect(result.trace.some((step) => step.outcome === 'deny')).toBe(true);
  });

  it('will not explain a user from another organization', async () => {
    const orgId = await newOrg('explain-three');
    await expect(
      authz.explain(orgId, {
        userId: OUTSIDER,
        permission: 'card:read',
        resourceType: null,
        resourceId: null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the audit projection', () => {
  it('turns outbox events into hash-chained entries', async () => {
    const orgId = await newOrg('audit-one');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );
    await members.changeRole(orgId, { userId: COLLEAGUE, role: 'admin' }, actorOf(OWNER));

    await drainOutboxFully();

    const entries = await audit.listAuditEntries(orgId, { limit: 50, before: null });
    expect(entries.map((entry) => entry.action)).toEqual([
      'member.role_changed',
      'member.added',
      // `newOrg` writes `org.created` and `billing.trial_started` (Phase 12
      // Wave 3) in the SAME transaction, `org.created` first — `uuidv7()` is
      // monotonic within a process, so the trial event's id always sorts
      // after the org's, and `ORDER BY seq DESC` lists it first here.
      'billing.trial_started',
      'org.created',
    ]);

    // The role change records BOTH roles: the direction is what matters, and
    // member -> admin and admin -> member are opposite incidents.
    expect(entries[0]?.changes).toMatchObject({ from: 'member', to: 'admin' });
  });

  it('does not duplicate entries when drained twice', async () => {
    // Claim, write and mark-published are one transaction, which is what makes
    // this consumer exactly-once rather than at-least-once.
    const orgId = await newOrg('audit-two');
    await drainOutboxFully();
    await drainOutboxFully();

    const entries = await audit.listAuditEntries(orgId, { limit: 50, before: null });
    // `org.created` + `billing.trial_started` (Phase 12 Wave 3) — one org
    // creation is two audit entries, not one.
    expect(entries).toHaveLength(2);
  });

  it('verifies an untouched chain', async () => {
    const orgId = await newOrg('audit-three');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );
    await teams.createTeam(orgId, { name: 'Ops', slug: 'ops' }, actorOf(OWNER));
    await drainOutboxFully();

    const result = await audit.verifyAuditLog(orgId);
    // org.created, billing.trial_started, member.added, team.created.
    expect(result.verified).toBe(4);
    expect(result.intact).toBe(true);
    expect(result.breaks).toEqual([]);
  });

  it('verifies an untouched chain of more than nine entries', async () => {
    /* The same assertion as above, past the boundary where the reader's ORDER BY
       used to matter. `readAuditChain` selects `seq::text AS seq`, and a bare
       `ORDER BY seq` binds to that OUTPUT ALIAS rather than the bigint column —
       so the verifier received 1, 10, 11, 12, 2, 3 … and reported sequence gaps
       and broken links on a chain nobody had touched.

       Below ten entries text and numeric order are identical, which is why the
       existing tests here — three entries, four entries — could not see it, and
       why this one seeds twelve. An integrity check that cries wolf on healthy
       data is worse than none: the response to a real detection becomes "the
       verifier is wrong again". */
    const orgId = await newOrg('audit-many');
    for (let i = 0; i < 11; i += 1) {
      await teams.createTeam(
        orgId,
        { name: `Team ${String(i)}`, slug: `team-${String(i)}` },
        actorOf(OWNER),
      );
    }
    await drainOutboxFully();

    const result = await audit.verifyAuditLog(orgId);
    // org.created, billing.trial_started, 11 team.created.
    expect(result.verified).toBe(13);
    expect(result.intact).toBe(true);
    expect(result.breaks).toEqual([]);
  });

  it('detects an entry edited behind the chain’s back', async () => {
    /* The point of the chain. No role in the system can do this — taskflow_audit
       holds no UPDATE and the app role holds no INSERT — so the tamper is
       applied as the migrator, standing in for someone with direct database
       access. Detection, not prevention, is the honest goal (§8.6). */
    const orgId = await newOrg('audit-four');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );
    await drainOutboxFully();

    expect((await audit.verifyAuditLog(orgId)).intact).toBe(true);

    await admin.setOrg(orgId);
    await admin.query(`UPDATE audit.audit_log SET action = 'member.removed' WHERE seq = 2`);
    await admin.setOrg(null);

    const result = await audit.verifyAuditLog(orgId);
    expect(result.intact).toBe(false);
    expect(result.breaks.map((entry) => entry.reason)).toContain('hash_mismatch');
  });

  it('detects an entry removed from the middle', async () => {
    /* Caught by prev_hash rather than by the digest: the survivors each still
       hash correctly on their own, and only the stored link records that
       something used to sit between them. */
    const orgId = await newOrg('audit-five');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );
    await teams.createTeam(orgId, { name: 'Ops', slug: 'ops' }, actorOf(OWNER));
    await drainOutboxFully();

    await admin.setOrg(orgId);
    await admin.query(`DELETE FROM audit.audit_log WHERE seq = 2`);
    await admin.setOrg(null);

    const result = await audit.verifyAuditLog(orgId);
    expect(result.intact).toBe(false);
    const reasons = result.breaks.map((entry) => entry.reason);
    expect(reasons).toContain('broken_link');
    expect(reasons).toContain('sequence_gap');
  });

  it('keeps one org’s entries out of another’s chain', async () => {
    const mine = await newOrg('audit-six');
    await newOrg('audit-seven', COLLEAGUE);
    await drainOutboxFully();

    const entries = await audit.listAuditEntries(mine, { limit: 50, before: null });
    // org.created + billing.trial_started for `mine` alone — `audit-seven`'s
    // own pair must not appear here.
    expect(entries).toHaveLength(2);
    expect((await audit.verifyAuditLog(mine)).intact).toBe(true);
  });
});

describe('suspension enforcement', () => {
  /* Phase 12 Wave 1 §3.3, pinned against real Postgres: identity.orgs is
     FORCE RLS keyed on app.org_id, and the enforcement read in
     resolveOrgMembership deliberately runs in `withUserScope` — the claim it
     rests on is that `orgs_self_read` (0004) admits the row through
     `app.user_id` for an ACTIVE member. This suite is what verifies that
     empirically rather than assuming it (§3.7's own warning). */
  it('refuses a suspended org for every member, including its owner', async () => {
    const orgId = await newOrg('suspend-enforce');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );

    await admin.setOrg(orgId);
    await admin.query(`UPDATE identity.orgs SET status = 'suspended' WHERE id = $1`, [orgId]);
    await admin.setOrg(null);

    /* ORG_SUSPENDED, not silent success and not NOT_A_MEMBER — the Owner is
       still a member, and the error has to say what actually happened. */
    await expect(resolveOrgMembership(OWNER, orgId)).rejects.toMatchObject({
      code: 'ORG_SUSPENDED',
    });
    await expect(resolveOrgMembership(COLLEAGUE, orgId)).rejects.toMatchObject({
      code: 'ORG_SUSPENDED',
    });
  });

  it('collapses a deleted org into NOT_A_MEMBER', async () => {
    /* §3.3's deliberate choice: nothing this wave produces 'deleted', and
       "that org used to exist" is the kind of cross-tenant fact a former
       member should not get confirmed by an error message. */
    const orgId = await newOrg('deleted-enforce');

    await admin.setOrg(orgId);
    await admin.query(`UPDATE identity.orgs SET status = 'deleted' WHERE id = $1`, [orgId]);
    await admin.setOrg(null);

    expect(await resolveOrgMembership(OWNER, orgId)).toBeNull();
  });

  /* The report this pass fixes: a member whose OWN row was suspended got a
     bare NOT_A_MEMBER, indistinguishable from having never joined at all —
     `resolveOrgMembership`'s own header has the full story. Mirrors the
     org-suspension suite above exactly, one level down: the row, not the
     org, is what changed. */
  it('refuses a suspended MEMBERSHIP with a distinct code, never NOT_A_MEMBER', async () => {
    const orgId = await newOrg('membership-suspend-enforce');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'member' },
      actorOf(OWNER),
    );

    await admin.setOrg(orgId);
    await admin.query(
      `UPDATE identity.memberships SET status = 'suspended' WHERE org_id = $1 AND user_id = $2`,
      [orgId, COLLEAGUE],
    );
    await admin.setOrg(null);

    await expect(resolveOrgMembership(COLLEAGUE, orgId)).rejects.toMatchObject({
      code: 'MEMBERSHIP_SUSPENDED',
    });
    // The OWNER's own, still-active row is untouched by the colleague's
    // suspension — this is a per-row fact, never an org-wide one.
    expect((await resolveOrgMembership(OWNER, orgId))?.role).toBe('owner');
  });

  it('still returns null for a row that never existed at all, not the suspended code', async () => {
    const orgId = await newOrg('membership-never-existed');
    expect(await resolveOrgMembership(OUTSIDER, orgId)).toBeNull();
  });
});

describe('billing enforcement (Phase 12 Wave 3 §3.2, superseded by Wave 4)', () => {
  /* Wave 3 refused resolveOrgMembership outright on a lapsed billing_status.
     Wave 4 replaced that lockout with the trial-to-Free design
     (resolve.ts's own header): a lapsed org lands on the default plan and
     keeps its data, enforced per-module by entitlements instead of at this
     one chokepoint. These assertions now prove the OPPOSITE of Wave 3's —
     that billing status alone never blocks membership resolution — pinned
     against real Postgres for the same reason the suspension suite above
     is: only an empirical run proves the read actually reaches a real row
     under RLS rather than silently seeing `undefined` and coincidentally
     reading as "not blocked". */
  it.each(['trialing', 'active', 'past_due', 'canceled'] as const)(
    'does not block a %s org',
    async (billingStatus) => {
      // `orgs_slug_format` (migration 0004) admits only [a-z0-9-] — swap the
      // status's underscore ('past_due') for a hyphen the constraint accepts.
      const orgId = await newOrg(`billing-${billingStatus.replace('_', '-')}-enforce`);

      await admin.setOrg(orgId);
      await admin.query(`UPDATE identity.orgs SET billing_status = $2 WHERE id = $1`, [
        orgId,
        billingStatus,
      ]);
      await admin.setOrg(null);

      expect((await resolveOrgMembership(OWNER, orgId))?.role).toBe('owner');
    },
  );

  it('an operator suspension still blocks access regardless of billing status', async () => {
    /* The two-column argument Wave 3 made (§3.2's migration header) still
       holds even though billing_status no longer blocks on its own: an
       operator's manual suspension must not be undoable by anything billing
       related, including a billing_status this org never even had trouble
       with. Two orgs, one paid and one canceled, both suspended — both must
       refuse, on the SAME error, because only `status` is being consulted. */
    const suspendedButPaid = await newOrg('operator-suspended-paid-enforce');
    await admin.setOrg(suspendedButPaid);
    await admin.query(
      `UPDATE identity.orgs SET status = 'suspended', billing_status = 'active' WHERE id = $1`,
      [suspendedButPaid],
    );
    await admin.setOrg(null);
    await expect(resolveOrgMembership(OWNER, suspendedButPaid)).rejects.toMatchObject({
      code: 'ORG_SUSPENDED',
    });

    const suspendedAndCanceled = await newOrg('operator-suspended-canceled-enforce');
    await admin.setOrg(suspendedAndCanceled);
    await admin.query(
      `UPDATE identity.orgs SET status = 'suspended', billing_status = 'canceled' WHERE id = $1`,
      [suspendedAndCanceled],
    );
    await admin.setOrg(null);
    await expect(resolveOrgMembership(OWNER, suspendedAndCanceled)).rejects.toMatchObject({
      code: 'ORG_SUSPENDED',
    });
  });
});

describe('ownership transfer', () => {
  it('hands the org over in one atomic transaction', async () => {
    const orgId = await newOrg('transfer-one');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'admin' },
      actorOf(OWNER),
    );

    const result = await members.transferOwnership(
      orgId,
      { toUserId: COLLEAGUE, selfNewRole: 'admin' },
      actorOf(OWNER),
    );
    expect(result.newOwnerId).toBe(COLLEAGUE);

    /* Both writes committed together: the new owner holds the role and the
       old owner does not. There was never an observable zero-owner moment
       between them. */
    expect((await resolveOrgMembership(COLLEAGUE, orgId))?.role).toBe('owner');
    expect((await resolveOrgMembership(OWNER, orgId))?.role).toBe('admin');
  });

  it('refuses a guest jumping straight to owner', async () => {
    /* §3.5's first decided edge case: transfer must not be a shortcut around
       the friction `isDirectlyAssignable` builds into reaching a real role. */
    const orgId = await newOrg('transfer-guest');
    await members.addMember(
      orgId,
      { email: 'outsider@tenancy.test', role: 'guest' },
      actorOf(OWNER),
    );

    await expect(
      members.transferOwnership(
        orgId,
        { toUserId: OUTSIDER, selfNewRole: 'admin' },
        actorOf(OWNER),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    /* And the org is untouched by the refusal. */
    expect((await resolveOrgMembership(OUTSIDER, orgId))?.role).toBe('guest');
    expect((await resolveOrgMembership(OWNER, orgId))?.role).toBe('owner');
  });

  it('emits member.ownership_transferred into the outbox', async () => {
    const orgId = await newOrg('transfer-event');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'admin' },
      actorOf(OWNER),
    );

    await members.transferOwnership(
      orgId,
      { toUserId: COLLEAGUE, selfNewRole: 'member' },
      actorOf(OWNER),
    );

    const rows = await withOrgScope(orgId, async (tx) =>
      tx.select({ name: schema.outbox.name }).from(schema.outbox),
    );
    expect(rows.map((row) => row.name)).toContain('member.ownership_transferred');
  });

  it('never leaves the org ownerless under concurrent transfers', async () => {
    /* Two simultaneous handoffs to two different admins both commit — the two
       writes of each are one transaction, so at no point is the org
       ownerless. A racing second owner is explicitly not this route's job to
       detect (§3.5); the invariant that MUST hold is that the caller's demotion
       never removes the last owner, and both calls together leave the caller
       demoted with owners standing. */
    const orgId = await newOrg('transfer-race');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'admin' },
      actorOf(OWNER),
    );
    await members.addMember(
      orgId,
      { email: 'outsider@tenancy.test', role: 'admin' },
      actorOf(OWNER),
    );

    await Promise.all([
      members.transferOwnership(
        orgId,
        { toUserId: COLLEAGUE, selfNewRole: 'admin' },
        actorOf(OWNER),
      ),
      members.transferOwnership(
        orgId,
        { toUserId: OUTSIDER, selfNewRole: 'admin' },
        actorOf(OWNER),
      ),
    ]);

    expect((await resolveOrgMembership(COLLEAGUE, orgId))?.role).toBe('owner');
    expect((await resolveOrgMembership(OUTSIDER, orgId))?.role).toBe('owner');
    expect((await resolveOrgMembership(OWNER, orgId))?.role).toBe('admin');
  });
});

describe('member grants (ai/phase-15-ai-copilot-and-permissions.md §1)', () => {
  it('gives a Guest an org-level permission their role alone denies, and the full stack agrees', async () => {
    /* The end-to-end property: a service write is visible to
       resolveOrgMembership's read, which is what subjectOf feeds the policy
       engine — not just that the row exists, but that `can()` on the real
       decision path changes its answer because of it. */
    const orgId = await newOrg('member-grant-one');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'guest' },
      actorOf(OWNER),
    );

    const before = await resolveOrgMembership(COLLEAGUE, orgId);
    expect(before?.memberGrants).toEqual([]);
    expect(can({ ...before!, userId: COLLEAGUE }, 'call:place').allowed).toBe(false);

    await memberGrants.grant(
      orgId,
      { userId: COLLEAGUE, permission: 'call:place' },
      actorOf(OWNER),
    );

    const after = await resolveOrgMembership(COLLEAGUE, orgId);
    expect(after?.memberGrants).toEqual(['call:place']);
    expect(can({ ...after!, userId: COLLEAGUE }, 'call:place').allowed).toBe(true);
    // A grant for one permission does not leak to a neighbouring one.
    expect(can({ ...after!, userId: COLLEAGUE }, 'sms:send').allowed).toBe(false);
  });

  it('revoking sets revoked_at rather than deleting the row, and the loader stops returning it immediately', async () => {
    const orgId = await newOrg('member-grant-two');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'guest' },
      actorOf(OWNER),
    );
    await admin.setOrg(orgId);
    const membershipRows = await admin.query(
      `SELECT id FROM identity.memberships WHERE org_id = $1 AND user_id = $2`,
      [orgId, COLLEAGUE],
    );
    await admin.setOrg(null);
    const membershipId = (membershipRows.rows[0] as { id: string } | undefined)?.id;
    if (membershipId === undefined) throw new Error('membership not found');

    await memberGrants.grant(
      orgId,
      { userId: COLLEAGUE, permission: 'call:place' },
      actorOf(OWNER),
    );
    expect(await loadMemberGrants(orgId, membershipId)).toEqual(['call:place']);

    await memberGrants.revoke(
      orgId,
      { userId: COLLEAGUE, permission: 'call:place' },
      actorOf(OWNER),
    );
    expect(await loadMemberGrants(orgId, membershipId)).toEqual([]);

    // The row is still there, marked revoked — history, not deletion.
    await admin.setOrg(orgId);
    const rows = await admin.query(
      `SELECT revoked_at FROM authz.member_grants WHERE membership_id = $1 AND permission = $2`,
      [membershipId, 'call:place'],
    );
    await admin.setOrg(null);
    const revokedRows = rows.rows as { revoked_at: Date | null }[];
    expect(revokedRows).toHaveLength(1);
    expect(revokedRows[0]?.revoked_at).not.toBeNull();
  });

  it('is idempotent, so granting something already granted returns the same row', async () => {
    const orgId = await newOrg('member-grant-three');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'guest' },
      actorOf(OWNER),
    );

    const first = await memberGrants.grant(
      orgId,
      { userId: COLLEAGUE, permission: 'call:place' },
      actorOf(OWNER),
    );
    const second = await memberGrants.grant(
      orgId,
      { userId: COLLEAGUE, permission: 'call:place' },
      actorOf(OWNER),
    );

    expect(second.grantId).toBe(first.grantId);
  });

  it('is idempotent on revoke too, so revoking an already-revoked grant no-ops rather than 404ing', async () => {
    // The property `permissions.tsx` (mobile) and `settings-page.tsx`'s bulk
    // revoke sheet (web) both depend on: a batch that retries the WHOLE
    // remaining selection after a step-up interruption must not fail on a
    // pair it already revoked earlier in the same batch.
    const orgId = await newOrg('member-grant-revoke-idempotent');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'guest' },
      actorOf(OWNER),
    );
    await memberGrants.grant(
      orgId,
      { userId: COLLEAGUE, permission: 'call:place' },
      actorOf(OWNER),
    );

    const first = await memberGrants.revoke(
      orgId,
      { userId: COLLEAGUE, permission: 'call:place' },
      actorOf(OWNER),
    );
    const second = await memberGrants.revoke(
      orgId,
      { userId: COLLEAGUE, permission: 'call:place' },
      actorOf(OWNER),
    );

    expect(first.revoked).toBe(true);
    expect(second.revoked).toBe(true);

    // Never-granted-at-all takes the identical no-op path.
    await expect(
      memberGrants.revoke(orgId, { userId: COLLEAGUE, permission: 'sms:send' }, actorOf(OWNER)),
    ).resolves.toEqual({ revoked: true });

    // A missing MEMBERSHIP is still a real 404 — that is not the same
    // failure as "already revoked".
    await expect(
      memberGrants.revoke(orgId, { userId: OUTSIDER, permission: 'call:place' }, actorOf(OWNER)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a permission that is not on the eligible list, even a real one', async () => {
    // `org:update` is a real permission in the catalog — the refusal is
    // `isGrantable`, not `isPermission`, and a caller must not be able to
    // hand out ownership-adjacent capability through this door.
    const orgId = await newOrg('member-grant-four');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'guest' },
      actorOf(OWNER),
    );

    await expect(
      memberGrants.grant(orgId, { userId: COLLEAGUE, permission: 'org:update' }, actorOf(OWNER)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a grant to someone outside the organization', async () => {
    const orgId = await newOrg('member-grant-five');
    await expect(
      memberGrants.grant(orgId, { userId: OUTSIDER, permission: 'call:place' }, actorOf(OWNER)),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lists every active grant in the org, and only the active ones', async () => {
    const orgId = await newOrg('member-grant-six');
    await members.addMember(
      orgId,
      { email: 'colleague@tenancy.test', role: 'guest' },
      actorOf(OWNER),
    );

    await memberGrants.grant(
      orgId,
      { userId: COLLEAGUE, permission: 'call:place' },
      actorOf(OWNER),
    );
    await memberGrants.grant(orgId, { userId: COLLEAGUE, permission: 'sms:send' }, actorOf(OWNER));
    await memberGrants.revoke(orgId, { userId: COLLEAGUE, permission: 'sms:send' }, actorOf(OWNER));

    const list = await memberGrants.listGrants(orgId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ userId: COLLEAGUE, permission: 'call:place' });
  });

  describe('revokeAll (offboarding automation, §8)', () => {
    it('revokes every active grant a member holds, and reports which', async () => {
      const orgId = await newOrg('member-grant-revoke-all-one');
      await members.addMember(
        orgId,
        { email: 'colleague@tenancy.test', role: 'guest' },
        actorOf(OWNER),
      );
      await memberGrants.grant(
        orgId,
        { userId: COLLEAGUE, permission: 'call:place' },
        actorOf(OWNER),
      );
      await memberGrants.grant(
        orgId,
        { userId: COLLEAGUE, permission: 'sms:send' },
        actorOf(OWNER),
      );

      const result = await memberGrants.revokeAll(orgId, COLLEAGUE, actorOf(OWNER));
      expect([...result.revoked].sort()).toEqual(['call:place', 'sms:send']);
      expect(await memberGrants.listGrants(orgId)).toEqual([]);
    });

    it('is a no-op, not an error, for a member holding zero grants', async () => {
      const orgId = await newOrg('member-grant-revoke-all-two');
      await members.addMember(
        orgId,
        { email: 'colleague@tenancy.test', role: 'guest' },
        actorOf(OWNER),
      );

      await expect(memberGrants.revokeAll(orgId, COLLEAGUE, actorOf(OWNER))).resolves.toEqual({
        revoked: [],
      });
    });

    it('404s for someone outside the organization', async () => {
      const orgId = await newOrg('member-grant-revoke-all-three');
      await expect(memberGrants.revokeAll(orgId, OUTSIDER, actorOf(OWNER))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});
