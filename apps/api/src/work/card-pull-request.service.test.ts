import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type CardId, type ListId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, withOrgScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as projects from './project.service.js';
import * as boards from './board.service.js';
import * as lists from './list.service.js';
import * as cards from './card.service.js';
import {
  autoLinkPullRequestFromBranchName,
  linkCardPullRequest,
  listCardPullRequests,
  notifyPullRequestMerged,
  unlinkCardPullRequest,
} from './card-pull-request.service.js';
import { cardPullRequestLinked, cardPullRequestMerged, cardPullRequestUnlinked } from './events.js';
import type { WorkActor } from './shared.js';

/**
 * The card <-> PR link (ai/phase-15-ai-copilot-and-permissions.md §7.2;
 * migration 0105) — the property only a real Postgres connection proves is
 * the composite primary key's idempotency (`onConflictDoNothing`) and the
 * `card:update`/`card:read` split, the identical shape `checklist.service.ts`
 * already established.
 */

const OWNER = unsafeAsId<'UserId'>('0195ef00-0000-7000-8000-000000000101');
const GUEST = unsafeAsId<'UserId'>('0195ef00-0000-7000-8000-000000000102');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@card-pr.test'],
  [GUEST, 'guest@card-pr.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ef00-0000-7000-8000-0000000001ff');

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
  await admin.query(`DELETE FROM work.card_pull_requests WHERE org_id = $1`, [orgId]);
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

async function makeCard(
  owner: WorkActor,
  fixture: Fixture,
): Promise<{ cardId: CardId; reference: string }> {
  const card = await cards.createCard(owner, {
    listId: fixture.listId,
    title: 'Fix login bug',
    description: null,
  });
  return { cardId: card.cardId, reference: card.reference };
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-card-pr-svc-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
});

describe('linkCardPullRequest', () => {
  it('links a PR and emits card.pull_request_linked', async () => {
    const fixture = await scaffold('card-pr-link');
    const card = await makeCard(fixture.owner, fixture);

    const result = await linkCardPullRequest(fixture.owner, {
      cardId: card.cardId,
      providerScope: 'acme/website',
      prNumber: 42,
    });
    expect(result).toEqual({ linked: true });

    const events = await outboxFor(fixture.orgId);
    const linked = events.filter((event) => event.name === cardPullRequestLinked.name);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.payload).toMatchObject({
      cardId: card.cardId,
      providerScope: 'acme/website',
      prNumber: 42,
    });

    const links = await listCardPullRequests(fixture.owner, { cardId: card.cardId });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ providerScope: 'acme/website', prNumber: 42 });
  });

  it('is idempotent — linking the same PR twice writes one row and one event', async () => {
    const fixture = await scaffold('card-pr-idempotent');
    const card = await makeCard(fixture.owner, fixture);

    await linkCardPullRequest(fixture.owner, {
      cardId: card.cardId,
      providerScope: 'acme/website',
      prNumber: 7,
    });
    await linkCardPullRequest(fixture.owner, {
      cardId: card.cardId,
      providerScope: 'acme/website',
      prNumber: 7,
    });

    const links = await listCardPullRequests(fixture.owner, { cardId: card.cardId });
    expect(links).toHaveLength(1);

    const events = await outboxFor(fixture.orgId);
    expect(events.filter((event) => event.name === cardPullRequestLinked.name)).toHaveLength(2);
  });

  it('refuses a guest with no card:update', async () => {
    const fixture = await scaffold('card-pr-refuse');
    const card = await makeCard(fixture.owner, fixture);
    const guest = await actorFor(fixture.orgId, GUEST, 'guest');

    await expect(
      linkCardPullRequest(guest, {
        cardId: card.cardId,
        providerScope: 'acme/website',
        prNumber: 1,
      }),
    ).rejects.toThrow();
  });
});

describe('unlinkCardPullRequest', () => {
  it('removes the link and emits card.pull_request_unlinked', async () => {
    const fixture = await scaffold('card-pr-unlink');
    const card = await makeCard(fixture.owner, fixture);
    await linkCardPullRequest(fixture.owner, {
      cardId: card.cardId,
      providerScope: 'acme/website',
      prNumber: 9,
    });

    const result = await unlinkCardPullRequest(fixture.owner, {
      cardId: card.cardId,
      providerScope: 'acme/website',
      prNumber: 9,
    });
    expect(result).toEqual({ unlinked: true });

    const links = await listCardPullRequests(fixture.owner, { cardId: card.cardId });
    expect(links).toHaveLength(0);

    const events = await outboxFor(fixture.orgId);
    expect(events.some((event) => event.name === cardPullRequestUnlinked.name)).toBe(true);
  });

  it('reports false, not an error, for a link that never existed', async () => {
    const fixture = await scaffold('card-pr-unlink-missing');
    const card = await makeCard(fixture.owner, fixture);

    const result = await unlinkCardPullRequest(fixture.owner, {
      cardId: card.cardId,
      providerScope: 'acme/website',
      prNumber: 999,
    });
    expect(result).toEqual({ unlinked: false });
  });
});

/**
 * The two system-caller functions the GitHub webhook invokes directly
 * (`ai/phase-15-ai-copilot-and-permissions.md` §7.2's last documented
 * automation gap) — neither takes a `WorkActor`, so these tests call them
 * inside their own `withOrgScope`, the same shape `integration-webhooks.ts`
 * itself uses.
 */
describe('notifyPullRequestMerged', () => {
  it('emits card.pull_request_merged for every card linked to the PR, never a batch', async () => {
    const fixture = await scaffold('card-pr-merged-multi');
    const cardA = await makeCard(fixture.owner, fixture);
    const cardB = await makeCard(fixture.owner, fixture);
    await linkCardPullRequest(fixture.owner, {
      cardId: cardA.cardId,
      providerScope: 'acme/website',
      prNumber: 55,
    });
    await linkCardPullRequest(fixture.owner, {
      cardId: cardB.cardId,
      providerScope: 'acme/website',
      prNumber: 55,
    });

    await withOrgScope(fixture.orgId, (tx) =>
      notifyPullRequestMerged(tx, fixture.orgId, 'acme/website', 55, requestId),
    );

    const events = await outboxFor(fixture.orgId);
    const merged = events.filter((event) => event.name === cardPullRequestMerged.name);
    expect(merged).toHaveLength(2);
    expect(merged.map((event) => event.payload['cardId']).sort()).toEqual(
      [cardA.cardId, cardB.cardId].sort(),
    );
    for (const event of merged) {
      expect(event.payload).toMatchObject({ providerScope: 'acme/website', prNumber: 55 });
    }
  });

  it('does nothing when no card is linked to the PR', async () => {
    const fixture = await scaffold('card-pr-merged-none');

    await withOrgScope(fixture.orgId, (tx) =>
      notifyPullRequestMerged(tx, fixture.orgId, 'acme/website', 999, requestId),
    );

    const events = await outboxFor(fixture.orgId);
    expect(events.filter((event) => event.name === cardPullRequestMerged.name)).toHaveLength(0);
  });
});

describe('autoLinkPullRequestFromBranchName', () => {
  it('links the card its branch name references, and emits card.pull_request_linked with linkedBy null', async () => {
    const fixture = await scaffold('card-pr-autolink-ok');
    const card = await makeCard(fixture.owner, fixture);
    const branchName = `${card.reference.toLowerCase()}-fix-login-redirect`;

    await withOrgScope(fixture.orgId, (tx) =>
      autoLinkPullRequestFromBranchName(
        tx,
        fixture.orgId,
        'acme/website',
        61,
        branchName,
        requestId,
      ),
    );

    const links = await listCardPullRequests(fixture.owner, { cardId: card.cardId });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      providerScope: 'acme/website',
      prNumber: 61,
      linkedBy: null,
    });

    const events = await outboxFor(fixture.orgId);
    const linked = events.filter((event) => event.name === cardPullRequestLinked.name);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.payload).toMatchObject({
      cardId: card.cardId,
      providerScope: 'acme/website',
      prNumber: 61,
    });
  });

  it('does nothing when the branch name has no recognizable reference', async () => {
    const fixture = await scaffold('card-pr-autolink-no-ref');
    const card = await makeCard(fixture.owner, fixture);

    await withOrgScope(fixture.orgId, (tx) =>
      autoLinkPullRequestFromBranchName(
        tx,
        fixture.orgId,
        'acme/website',
        62,
        'fix-something-unrelated',
        requestId,
      ),
    );

    const links = await listCardPullRequests(fixture.owner, { cardId: card.cardId });
    expect(links).toHaveLength(0);
  });

  it('does nothing when the branch name references a card that does not exist', async () => {
    const fixture = await scaffold('card-pr-autolink-missing-card');

    await withOrgScope(fixture.orgId, (tx) =>
      autoLinkPullRequestFromBranchName(
        tx,
        fixture.orgId,
        'acme/website',
        63,
        'web-999999-fix-nothing',
        requestId,
      ),
    );

    const events = await outboxFor(fixture.orgId);
    expect(events.filter((event) => event.name === cardPullRequestLinked.name)).toHaveLength(0);
  });

  it('is idempotent — running it twice for the same PR writes one row and emits one event, unlike linkCardPullRequest', async () => {
    const fixture = await scaffold('card-pr-autolink-idempotent');
    const card = await makeCard(fixture.owner, fixture);
    const branchName = `${card.reference.toLowerCase()}-fix-x`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await withOrgScope(fixture.orgId, (tx) =>
        autoLinkPullRequestFromBranchName(
          tx,
          fixture.orgId,
          'acme/website',
          64,
          branchName,
          requestId,
        ),
      );
    }

    const links = await listCardPullRequests(fixture.owner, { cardId: card.cardId });
    expect(links).toHaveLength(1);

    const events = await outboxFor(fixture.orgId);
    expect(events.filter((event) => event.name === cardPullRequestLinked.name)).toHaveLength(1);
  });
});
