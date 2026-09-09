import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isAppError,
  unsafeAsId,
  type OrgId,
  type ProjectId,
  type UserId,
} from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as projects from './project.service.js';
import * as boards from './board.service.js';
import * as guestAccess from './guest-access.service.js';
import type { WorkActor } from './shared.js';

/**
 * Guest access into Work (project-scoped) — the direct counterpart to
 * `chat/guest.test.ts` for `chat/compliance.service.ts`'s own guest access,
 * one level up: a Work project rather than a chat channel.
 *
 * ## The property under test is the SAME absence chat's own tests prove
 *
 * `GUEST` grants nothing from the role (`roles.ts` has it as an empty
 * list). Guest access to a project IS a `viewer`/`commenter`/`editor` tuple
 * naming that project, marked `is_guest` only for review — there is no
 * `if (isGuest)` branch anywhere in `guest-access.service.ts`, and these
 * tests exist to prove the absence produces the right answers.
 *
 * ## The regression test for the listing leak this feature's prerequisite
 * fix closes
 *
 * `listProjects`/`listBoards` both returned every row in the org before this
 * fix, unfiltered — harmless only because every non-guest role holds
 * `project:read`/`board:read` flatly. The moment a Guest holds a real
 * project-level tuple, that stops being true, and `sees only the invited
 * project` below is the test that would have failed against the
 * pre-fix code.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000001');
const GUEST = unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000002');
const MEMBER = unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000003');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@guest-work.test'],
  [GUEST, 'guest@guest-work.test'],
  [MEMBER, 'member@guest-work.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee10-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
const created: OrgId[] = [];

async function actorFor(orgId: OrgId, userId: UserId, role: Subject['role']): Promise<WorkActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

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
    'work.cards',
    'work.lists',
    'work.boards',
    'work.projects',
    'authz.relationship_tuples',
    'identity.memberships',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

interface Fixture {
  readonly orgId: OrgId;
  readonly owner: WorkActor;
  readonly refreshOwner: () => Promise<WorkActor>;
  readonly projectId: ProjectId;
  readonly otherProjectId: ProjectId;
}

async function scaffold(slug: string): Promise<Fixture> {
  const result = await orgs.createOrg(
    { name: `Guest work ${slug}`, slug },
    { userId: OWNER, requestId },
  );
  created.push(result.orgId);

  await members.addMember(
    result.orgId,
    { email: 'guest@guest-work.test', role: 'guest' },
    { userId: OWNER, requestId },
  );
  await members.addMember(
    result.orgId,
    { email: 'member@guest-work.test', role: 'member' },
    { userId: OWNER, requestId },
  );

  const owner = await actorFor(result.orgId, OWNER, 'owner');
  const project = await projects.createProject(owner, {
    name: 'Website',
    key: 'WEB',
    description: null,
  });
  const other = await projects.createProject(owner, {
    name: 'Internal',
    key: 'INT',
    description: null,
  });
  await boards.createBoard(owner, { projectId: project.projectId, name: 'Delivery' });

  return {
    orgId: result.orgId,
    owner,
    refreshOwner: () => actorFor(result.orgId, OWNER, 'owner'),
    projectId: project.projectId,
    otherProjectId: other.projectId,
  };
}

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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-guest-work-test' });
});

afterAll(async () => {
  await closeDatabase();
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
});

describe('a guest with no grant', () => {
  it('sees an empty project list', async () => {
    const { orgId } = await scaffold('none');
    const guest = await actorFor(orgId, GUEST, 'guest');
    expect(await projects.listProjects(guest, { includeArchived: false })).toEqual([]);
  });

  it('cannot read the project directly', async () => {
    const { orgId, projectId } = await scaffold('none-direct');
    const guest = await actorFor(orgId, GUEST, 'guest');
    expect(
      await rejectionCode(() => boards.listBoards(guest, { projectId, includeArchived: false })),
    ).toBe('NOT_FOUND');
  });
});

describe('a guest invited to one project', () => {
  it('sees only the invited project in listProjects — the leak this feature fixes', async () => {
    const { orgId, refreshOwner, projectId } = await scaffold('leak-fix');

    await guestAccess.inviteGuestToProject(await refreshOwner(), {
      projectId,
      userId: GUEST,
      relation: 'viewer',
      expiresAt: null,
    });

    const guest = await actorFor(orgId, GUEST, 'guest');
    const seen = await projects.listProjects(guest, { includeArchived: false });
    expect(seen.map((row) => row.projectId)).toEqual([projectId]);
  });

  it('can read the invited project boards through listBoards', async () => {
    const { orgId, refreshOwner, projectId } = await scaffold('boards');

    await guestAccess.inviteGuestToProject(await refreshOwner(), {
      projectId,
      userId: GUEST,
      relation: 'viewer',
      expiresAt: null,
    });

    const guest = await actorFor(orgId, GUEST, 'guest');
    const rows = await boards.listBoards(guest, { projectId, includeArchived: false });
    expect(rows.map((row) => row.name)).toEqual(['Delivery']);
  });

  it('cannot reach a sibling project it holds no tuple on', async () => {
    const { orgId, refreshOwner, projectId, otherProjectId } = await scaffold('contained');

    await guestAccess.inviteGuestToProject(await refreshOwner(), {
      projectId,
      userId: GUEST,
      relation: 'viewer',
      expiresAt: null,
    });

    const guest = await actorFor(orgId, GUEST, 'guest');
    expect(
      await rejectionCode(() =>
        boards.listBoards(guest, { projectId: otherProjectId, includeArchived: false }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('loses access the moment it is revoked', async () => {
    const { orgId, refreshOwner, projectId } = await scaffold('revoked');

    await guestAccess.inviteGuestToProject(await refreshOwner(), {
      projectId,
      userId: GUEST,
      relation: 'viewer',
      expiresAt: null,
    });
    await guestAccess.revokeGuestAccess(await refreshOwner(), { projectId, userId: GUEST });

    const guest = await actorFor(orgId, GUEST, 'guest');
    expect(
      await rejectionCode(() => boards.listBoards(guest, { projectId, includeArchived: false })),
    ).toBe('NOT_FOUND');
  });

  it('is marked as a guest on the tuple, for access review', async () => {
    const { orgId, refreshOwner, projectId } = await scaffold('marked');

    await guestAccess.inviteGuestToProject(await refreshOwner(), {
      projectId,
      userId: GUEST,
      relation: 'viewer',
      expiresAt: null,
    });

    await admin.setOrg(orgId);
    const result = await admin.query(
      `SELECT is_guest FROM authz.relationship_tuples
       WHERE org_id = $1 AND subject_id = $2 AND object_id = $3`,
      [orgId, GUEST, projectId],
    );
    await admin.setOrg(null);

    expect((result.rows as { is_guest: boolean }[])[0]?.is_guest).toBe(true);
  });

  it('re-inviting at a different relation replaces the old grant, not adds a second', async () => {
    const { refreshOwner, projectId } = await scaffold('reinvite');

    await guestAccess.inviteGuestToProject(await refreshOwner(), {
      projectId,
      userId: GUEST,
      relation: 'viewer',
      expiresAt: null,
    });
    await guestAccess.inviteGuestToProject(await refreshOwner(), {
      projectId,
      userId: GUEST,
      relation: 'editor',
      expiresAt: null,
    });

    const rows = await guestAccess.listProjectGuests(await refreshOwner(), { projectId });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relation).toBe('editor');
  });
});

describe('validation', () => {
  it('refuses a relation outside viewer/commenter/editor', async () => {
    const { refreshOwner, projectId } = await scaffold('bad-relation');

    expect(
      await rejectionCode(async () =>
        guestAccess.inviteGuestToProject(await refreshOwner(), {
          projectId,
          userId: GUEST,
          relation: 'owner',
          expiresAt: null,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('refuses a target whose membership role is not guest', async () => {
    const { refreshOwner, projectId } = await scaffold('not-guest');

    expect(
      await rejectionCode(async () =>
        guestAccess.inviteGuestToProject(await refreshOwner(), {
          projectId,
          userId: MEMBER,
          relation: 'viewer',
          expiresAt: null,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('listProjectGuests — the invite panel roster', () => {
  it('lists an invited guest, with their relation', async () => {
    const { refreshOwner, projectId } = await scaffold('roster');

    await guestAccess.inviteGuestToProject(await refreshOwner(), {
      projectId,
      userId: GUEST,
      relation: 'commenter',
      expiresAt: null,
    });

    const rows = await guestAccess.listProjectGuests(await refreshOwner(), { projectId });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(GUEST);
    expect(rows[0]?.relation).toBe('commenter');
  });

  it('no longer lists a guest once access is revoked', async () => {
    const { refreshOwner, projectId } = await scaffold('roster-revoked');

    await guestAccess.inviteGuestToProject(await refreshOwner(), {
      projectId,
      userId: GUEST,
      relation: 'viewer',
      expiresAt: null,
    });
    await guestAccess.revokeGuestAccess(await refreshOwner(), { projectId, userId: GUEST });

    expect(await guestAccess.listProjectGuests(await refreshOwner(), { projectId })).toEqual([]);
  });
});
