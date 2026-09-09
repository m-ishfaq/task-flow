import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type CardId, type ListId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as projects from './project.service.js';
import * as boards from './board.service.js';
import * as lists from './list.service.js';
import * as cards from './card.service.js';
import { linkCardBranch, listCardBranches, unlinkCardBranch } from './card-branch.service.js';
import { cardBranchLinked, cardBranchUnlinked } from './events.js';
import type { WorkActor } from './shared.js';

/**
 * The card <-> git branch link (ai/phase-15-ai-copilot-and-permissions.md
 * §7.2; migration 0106) — the identical `card-pull-request.service.test.ts`
 * shape one entity type over: the composite primary key's idempotency
 * (`onConflictDoNothing`) and the `card:update`/`card:read` split are both
 * properties only a real Postgres connection proves.
 */

const OWNER = unsafeAsId<'UserId'>('0195ef10-0000-7000-8000-000000000101');
const GUEST = unsafeAsId<'UserId'>('0195ef10-0000-7000-8000-000000000102');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@card-branch.test'],
  [GUEST, 'guest@card-branch.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ef10-0000-7000-8000-0000000001ff');

let admin: AdminConnection;
let created: OrgId[] = [];

async function actorFor(orgId: OrgId, userId: UserId, role: Subject['role']): Promise<WorkActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM audit.audit_log WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM audit.chain_heads WHERE org_id = $1`, [orgId]);
  await admin.query(
    `DELETE FROM platform.outbox_dispatch WHERE event_id IN
       (SELECT id FROM platform.outbox WHERE org_id = $1)`,
    [orgId],
  );
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  /* Children before parents: the link before the card, the card before the
     list/board/project. */
  await admin.query(`DELETE FROM work.card_branches WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.views WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

async function outboxFor(
  orgId: OrgId,
): Promise<{ name: string; payload: Record<string, unknown> }[]> {
  await admin.setOrg(orgId);
  const rows = await admin.query(
    `SELECT name, payload FROM platform.outbox WHERE org_id = $1 ORDER BY created_at`,
    [orgId],
  );
  await admin.setOrg(null);
  return rows.rows.map((row) => ({
    name: String(row['name']),
    payload: (row['payload'] ?? {}) as Record<string, unknown>,
  }));
}

interface Fixture {
  readonly orgId: OrgId;
  readonly owner: WorkActor;
  readonly listId: ListId;
}

async function scaffold(slug: string): Promise<Fixture> {
  const orgId = await newOrg(slug);
  const owner = await actorFor(orgId, OWNER, 'owner');

  const project = await projects.createProject(owner, {
    name: 'Website',
    key: 'WEB',
    description: null,
  });
  const board = await boards.createBoard(owner, { projectId: project.projectId, name: 'Delivery' });
  const list = await lists.createList(owner, {
    boardId: board.boardId,
    name: 'Todo',
    wipLimit: null,
  });

  return { orgId, owner, listId: list.listId };
}

async function makeCard(owner: WorkActor, fixture: Fixture): Promise<{ cardId: CardId }> {
  const card = await cards.createCard(owner, {
    listId: fixture.listId,
    title: 'Fix login bug',
    description: null,
  });
  return { cardId: card.cardId };
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

  initializeDatabase({
    url: TEST_ENV.DATABASE_URL,
    applicationName: 'taskflow-card-branch-svc-test',
  });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
});

describe('linkCardBranch', () => {
  it('links a branch and emits card.branch_linked', async () => {
    const fixture = await scaffold('card-branch-link');
    const card = await makeCard(fixture.owner, fixture);

    const result = await linkCardBranch(fixture.owner, {
      cardId: card.cardId,
      providerScope: 'acme/website',
      branchName: 'web-142-fix-login-redirect',
    });
    expect(result).toEqual({ linked: true });

    const events = await outboxFor(fixture.orgId);
    const linked = events.filter((event) => event.name === cardBranchLinked.name);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.payload).toMatchObject({
      cardId: card.cardId,
      providerScope: 'acme/website',
      branchName: 'web-142-fix-login-redirect',
    });

    const links = await listCardBranches(fixture.owner, { cardId: card.cardId });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      providerScope: 'acme/website',
      branchName: 'web-142-fix-login-redirect',
    });
  });

  it('is idempotent — linking the same branch twice writes one row and one event', async () => {
    const fixture = await scaffold('card-branch-idempotent');
    const card = await makeCard(fixture.owner, fixture);

    await linkCardBranch(fixture.owner, {
      cardId: card.cardId,
      providerScope: 'acme/website',
      branchName: 'web-7-fix-x',
    });
    await linkCardBranch(fixture.owner, {
      cardId: card.cardId,
      providerScope: 'acme/website',
      branchName: 'web-7-fix-x',
    });

    const links = await listCardBranches(fixture.owner, { cardId: card.cardId });
    expect(links).toHaveLength(1);

    const events = await outboxFor(fixture.orgId);
    expect(events.filter((event) => event.name === cardBranchLinked.name)).toHaveLength(2);
  });

  it('refuses a guest with no card:update', async () => {
    const fixture = await scaffold('card-branch-refuse');
    const card = await makeCard(fixture.owner, fixture);
    const guest = await actorFor(fixture.orgId, GUEST, 'guest');

    await expect(
      linkCardBranch(guest, {
        cardId: card.cardId,
        providerScope: 'acme/website',
        branchName: 'web-1-x',
      }),
    ).rejects.toThrow();
  });
});

describe('unlinkCardBranch', () => {
  it('removes the link and emits card.branch_unlinked', async () => {
    const fixture = await scaffold('card-branch-unlink');
    const card = await makeCard(fixture.owner, fixture);
    await linkCardBranch(fixture.owner, {
      cardId: card.cardId,
      providerScope: 'acme/website',
      branchName: 'web-9-x',
    });

    const result = await unlinkCardBranch(fixture.owner, {
      cardId: card.cardId,
      providerScope: 'acme/website',
      branchName: 'web-9-x',
    });
    expect(result).toEqual({ unlinked: true });

    const links = await listCardBranches(fixture.owner, { cardId: card.cardId });
    expect(links).toHaveLength(0);

    const events = await outboxFor(fixture.orgId);
    expect(events.some((event) => event.name === cardBranchUnlinked.name)).toBe(true);
  });

  it('reports false, not an error, for a link that never existed', async () => {
    const fixture = await scaffold('card-branch-unlink-missing');
    const card = await makeCard(fixture.owner, fixture);

    const result = await unlinkCardBranch(fixture.owner, {
      cardId: card.cardId,
      providerScope: 'acme/website',
      branchName: 'web-999-x',
    });
    expect(result).toEqual({ unlinked: false });
  });
});
