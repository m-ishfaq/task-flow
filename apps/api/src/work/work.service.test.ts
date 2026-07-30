import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isRank,
  unsafeAsId,
  type BoardId,
  type ListId,
  type OrgId,
  type ProjectId,
  type UserId,
} from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, schema, withOrgScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import * as grants from '../tenancy/grant.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as projects from './project.service.js';
import * as boards from './board.service.js';
import * as lists from './list.service.js';
import * as cards from './card.service.js';
import type { WorkActor } from './shared.js';

/**
 * The Work slice, end to end, against real Postgres (`docker compose up -d`).
 *
 * "Tests ship with the slice. A slice with untested authorization is not done."
 *
 * The properties asserted here are the ones only a real execution demonstrates:
 * a card number handed out under a row lock and never reused, a composite
 * foreign key refusing a card whose list belongs to another board, an
 * optimistic-concurrency check adjudicating two writers who both read version 1,
 * a `viewer` tuple taking back a capability the caller's role granted, and a
 * degenerate list repaired by the move that discovered it.
 *
 * A mocked version of any of those would only prove the test agrees with itself.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee00-0000-7000-8000-000000000001');
const MEMBER = unsafeAsId<'UserId'>('0195ee00-0000-7000-8000-000000000002');
const VIEWER = unsafeAsId<'UserId'>('0195ee00-0000-7000-8000-000000000003');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@work.test'],
  [MEMBER, 'member@work.test'],
  [VIEWER, 'viewer@work.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee00-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
let created: OrgId[] = [];

/**
 * Builds the actor a Work service expects, with tuples loaded from the database.
 *
 * Loading them for real rather than passing a literal is the point of several
 * tests below: the restrictive-grant behaviour depends on the tuple arriving
 * through the same loader the request path uses, expanded from teams and
 * filtered for expiry.
 */
async function actorFor(orgId: OrgId, userId: UserId, role: Subject['role']): Promise<WorkActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg(
    { name: `Org ${slug}`, slug },
    {
      userId: OWNER,
      requestId,
    },
  );
  created.push(result.orgId);
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM audit.audit_log WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM audit.chain_heads WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.team_members WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.teams WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

/** A project, board and list — the scaffolding almost every test below needs. */
interface Fixture {
  readonly orgId: OrgId;
  readonly owner: WorkActor;
  readonly projectId: ProjectId;
  readonly boardId: BoardId;
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
  const board = await boards.createBoard(owner, {
    projectId: project.projectId,
    name: 'Delivery',
  });
  const list = await lists.createList(owner, {
    boardId: board.boardId,
    name: 'Todo',
    wipLimit: null,
  });

  return {
    orgId,
    owner,
    projectId: project.projectId,
    boardId: board.boardId,
    listId: list.listId,
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-work-svc-test' });
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

describe('projects', () => {
  it('rejects a duplicate key within an org but allows it across orgs', async () => {
    const first = await scaffold('work-keys-a');

    await expect(
      projects.createProject(first.owner, { name: 'Other', key: 'WEB', description: null }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // A different tenant wanting `WEB` is the normal case, not a collision.
    const second = await scaffold('work-keys-b');
    expect(second.projectId).not.toBe(first.projectId);
  });

  it('emits project.created into the outbox in the same transaction', async () => {
    const fixture = await scaffold('work-events');

    const rows = await withOrgScope(fixture.orgId, async (tx) =>
      tx.select({ name: schema.outbox.name }).from(schema.outbox),
    );

    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(['project.created', 'board.created', 'list.created']),
    );
  });
});

describe('card numbering', () => {
  it('hands out consecutive numbers starting at 1', async () => {
    const fixture = await scaffold('work-numbers');

    const first = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'First',
      description: null,
    });
    const second = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Second',
      description: null,
    });

    // `WEB-1`, not `WEB-0` and not `WEB-2` — the off-by-one in reading
    // `UPDATE ... RETURNING` back is invisible except here.
    expect(first.reference).toBe('WEB-1');
    expect(second.reference).toBe('WEB-2');
  });

  it('never issues the same number twice under concurrent creation', async () => {
    const fixture = await scaffold('work-numbers-race');

    /* The row lock on the project is what makes this safe, and the unique index
       on (org_id, project_id, number) is what would catch it if it were not.
       Ten parallel creates is the cheapest way to demonstrate both. */
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        cards.createCard(fixture.owner, {
          listId: fixture.listId,
          title: `Card ${String(index)}`,
          description: null,
        }),
      ),
    );

    const references = results.map((result) => result.reference).sort();
    expect(new Set(references).size).toBe(10);
    expect(references).toEqual(
      Array.from({ length: 10 }, (_, index) => `WEB-${String(index + 1)}`).sort(),
    );
  });
});

describe('ordering', () => {
  it('appends new cards in creation order', async () => {
    const fixture = await scaffold('work-order');

    for (const title of ['A', 'B', 'C']) {
      await cards.createCard(fixture.owner, {
        listId: fixture.listId,
        title,
        description: null,
      });
    }

    const rendered = await cards.listCards(fixture.owner, { boardId: fixture.boardId });
    expect(rendered.map((card) => card.title)).toEqual(['A', 'B', 'C']);
    for (const card of rendered) expect(isRank(card.rank)).toBe(true);
  });

  it('moves a card between two neighbours without touching them', async () => {
    const fixture = await scaffold('work-move');

    const a = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'A',
      description: null,
    });
    const b = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'B',
      description: null,
    });
    const c = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'C',
      description: null,
    });

    const before = await cards.listCards(fixture.owner, { boardId: fixture.boardId });
    const rankOfA = before.find((card) => card.cardId === a.cardId)?.rank;
    const rankOfB = before.find((card) => card.cardId === b.cardId)?.rank;

    // Move C between A and B.
    await cards.moveCard(fixture.owner, {
      cardId: c.cardId,
      targetListId: fixture.listId,
      beforeCardId: a.cardId,
      afterCardId: b.cardId,
    });

    const after = await cards.listCards(fixture.owner, { boardId: fixture.boardId });
    expect(after.map((card) => card.title)).toEqual(['A', 'C', 'B']);

    /* The single-row write property from §10.1. If the neighbours moved, the
       implementation is renumbering rather than fractionally indexing, and
       every concurrent drag becomes a conflict. */
    expect(after.find((card) => card.cardId === a.cardId)?.rank).toBe(rankOfA);
    expect(after.find((card) => card.cardId === b.cardId)?.rank).toBe(rankOfB);
  });

  it('moves a card to another list on the same board', async () => {
    const fixture = await scaffold('work-move-list');

    const doing = await lists.createList(fixture.owner, {
      boardId: fixture.boardId,
      name: 'Doing',
      wipLimit: null,
    });

    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Travelling',
      description: null,
    });

    const result = await cards.moveCard(fixture.owner, {
      cardId: card.cardId,
      targetListId: doing.listId,
      beforeCardId: null,
      afterCardId: null,
    });

    expect(result.listId).toBe(doing.listId);

    const detail = await cards.getCard(fixture.owner, { cardId: card.cardId });
    expect(detail.listId).toBe(doing.listId);
  });

  it('refuses a neighbour that is not in the target list', async () => {
    const fixture = await scaffold('work-move-stale');

    const doing = await lists.createList(fixture.owner, {
      boardId: fixture.boardId,
      name: 'Doing',
      wipLimit: null,
    });

    const inTodo = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Stays',
      description: null,
    });
    const moving = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Moves',
      description: null,
    });

    /* A stale client: the board it rendered showed `inTodo` in Doing. Placing
       the card "somewhere near where they meant" is how a drag silently lands
       in the wrong column, so this is a 404. */
    await expect(
      cards.moveCard(fixture.owner, {
        cardId: moving.cardId,
        targetListId: doing.listId,
        beforeCardId: inTodo.cardId,
        afterCardId: null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('repairs a degenerate list and reports it, rather than failing the move', async () => {
    const fixture = await scaffold('work-rebalance');

    const first = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'First',
      description: null,
    });
    const second = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Second',
      description: null,
    });
    const mover = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Mover',
      description: null,
    });

    /* Force the pathology that concurrency produces legitimately: two adjacent
       cards holding the SAME rank. `between` cannot generate a value strictly
       between them, and the move that discovers it must repair the list rather
       than refuse the drag. */
    await admin.setOrg(fixture.orgId);
    await admin.query(`UPDATE work.cards SET rank = 'a0' WHERE id = ANY($1::uuid[])`, [
      [first.cardId, second.cardId],
    ]);
    await admin.setOrg(null);

    const result = await cards.moveCard(fixture.owner, {
      cardId: mover.cardId,
      targetListId: fixture.listId,
      beforeCardId: first.cardId,
      afterCardId: second.cardId,
    });

    expect(result.rebalanced).toBe(true);

    const rendered = await cards.listCards(fixture.owner, { boardId: fixture.boardId });
    const ranks = rendered.map((card) => card.rank);

    // Every rank distinct and ascending — the list is genuinely repaired, not
    // merely made writable for this one call.
    expect(new Set(ranks).size).toBe(ranks.length);
    expect([...ranks].sort()).toEqual(ranks);
    expect(rendered.map((card) => card.title)).toEqual(['First', 'Mover', 'Second']);
  });

  it('emits list.rebalanced alongside card.moved so clients refetch', async () => {
    const fixture = await scaffold('work-rebalance-event');

    const first = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'First',
      description: null,
    });
    const second = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Second',
      description: null,
    });
    const mover = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Mover',
      description: null,
    });

    await admin.setOrg(fixture.orgId);
    await admin.query(`UPDATE work.cards SET rank = 'a0' WHERE id = ANY($1::uuid[])`, [
      [first.cardId, second.cardId],
    ]);
    await admin.setOrg(null);

    await cards.moveCard(fixture.owner, {
      cardId: mover.cardId,
      targetListId: fixture.listId,
      beforeCardId: first.cardId,
      afterCardId: second.cardId,
    });

    const emitted = await withOrgScope(fixture.orgId, async (tx) =>
      tx.select({ name: schema.outbox.name }).from(schema.outbox),
    );

    const names = emitted.map((row) => row.name);
    expect(names).toContain('card.moved');
    // Without this, the repair silently desynchronizes every open board.
    expect(names).toContain('list.rebalanced');
  });
});

describe('work-in-progress limits', () => {
  it('reports a breach without refusing the move', async () => {
    const fixture = await scaffold('work-wip');

    const tight = await lists.createList(fixture.owner, {
      boardId: fixture.boardId,
      name: 'Doing',
      wipLimit: 1,
    });

    const first = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'First',
      description: null,
    });
    const second = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Second',
      description: null,
    });

    const under = await cards.moveCard(fixture.owner, {
      cardId: first.cardId,
      targetListId: tight.listId,
      beforeCardId: null,
      afterCardId: null,
    });
    expect(under.wipExceeded).toBe(false);

    const over = await cards.moveCard(fixture.owner, {
      cardId: second.cardId,
      targetListId: tight.listId,
      beforeCardId: first.cardId,
      afterCardId: null,
    });

    /* Advisory, deliberately. Blocking someone from recording work that is
       already in progress makes people stop using the board, not stop the work.
       The move completes and the breach is reported. */
    expect(over.wipExceeded).toBe(true);

    const rendered = await cards.listCards(fixture.owner, { boardId: fixture.boardId });
    expect(rendered.filter((card) => card.listId === tight.listId)).toHaveLength(2);
  });
});

describe('optimistic concurrency', () => {
  it('accepts the first writer and refuses the second', async () => {
    const fixture = await scaffold('work-version');

    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Contended',
      description: null,
    });

    const loaded = await cards.getCard(fixture.owner, { cardId: card.cardId });
    expect(loaded.version).toBe(1);

    const update = (title: string): ReturnType<typeof cards.updateCard> =>
      cards.updateCard(fixture.owner, {
        cardId: card.cardId,
        version: loaded.version,
        title,
        description: null,
        dueDate: null,
        startDate: null,
      });

    const first = await update('Rewritten by A');
    expect(first.version).toBe(2);

    /* B read version 1 too. Without the version in the WHERE clause this would
       silently overwrite A's sentence, and neither of them would ever know. */
    await expect(update('Rewritten by B')).rejects.toMatchObject({ code: 'CONFLICT' });

    const final = await cards.getCard(fixture.owner, { cardId: card.cardId });
    expect(final.title).toBe('Rewritten by A');
  });
});

describe('the hierarchy is enforced by the database', () => {
  it('refuses a card whose list belongs to another board', async () => {
    const fixture = await scaffold('work-hierarchy');

    const otherBoard = await boards.createBoard(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Other',
    });

    /* A card carries board_id AND list_id, denormalized. RLS would not catch a
       card written into the wrong board of the SAME tenant — that is an
       ordinary authorization bug, not a tenancy one — so the composite foreign
       key is what makes it unwritable. Asserted directly against the database
       because no service path can express it. */
    await admin.setOrg(fixture.orgId);
    await expect(
      admin.query(
        `INSERT INTO work.cards (id, org_id, project_id, board_id, list_id, number, title, rank)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 999, 'Smuggled', 'a0')`,
        [fixture.orgId, fixture.projectId, otherBoard.boardId, fixture.listId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await admin.setOrg(null);
  });

  it('refuses a board whose project belongs to another org', async () => {
    const mine = await scaffold('work-cross-a');
    const theirs = await scaffold('work-cross-b');

    await admin.setOrg(mine.orgId);
    await expect(
      admin.query(
        `INSERT INTO work.boards (id, org_id, project_id, name, rank)
         VALUES (gen_random_uuid(), $1, $2, 'Smuggled', 'a0')`,
        [mine.orgId, theirs.projectId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await admin.setOrg(null);
  });
});

describe('authorization beyond the role', () => {
  it('lets a member create and move cards', async () => {
    const fixture = await scaffold('work-member');
    await members.addMember(
      fixture.orgId,
      { email: 'member@work.test', role: 'member' },
      { userId: OWNER, requestId },
    );

    const member = await actorFor(fixture.orgId, MEMBER, 'member');

    const card = await cards.createCard(member, {
      listId: fixture.listId,
      title: 'Mine',
      description: null,
    });
    expect(card.reference).toBe('WEB-1');
  });

  it('refuses a member the project-level capabilities the matrix reserves', async () => {
    const fixture = await scaffold('work-member-limits');
    await members.addMember(
      fixture.orgId,
      { email: 'member@work.test', role: 'member' },
      { userId: OWNER, requestId },
    );

    const member = await actorFor(fixture.orgId, MEMBER, 'member');

    // §8.2: project and board creation are Owner/Admin. A member holds
    // `project:read` and nothing that changes the project's shape.
    await expect(
      projects.updateProject(member, {
        projectId: fixture.projectId,
        name: 'Renamed',
        description: null,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('caps a member to read-only on a board where they hold a viewer tuple', async () => {
    const fixture = await scaffold('work-viewer');
    await members.addMember(
      fixture.orgId,
      { email: 'viewer@work.test', role: 'member' },
      { userId: OWNER, requestId },
    );

    /* The worked example from §8.2. The role grants `card:update`; the
       restrictive `viewer` relation on this board takes it back. Sharing a board
       read-only must not silently confer write access, which is the opposite of
       what the person sharing it believes they did. */
    await grants.grant(
      fixture.orgId,
      {
        subjectType: 'user',
        subjectId: VIEWER,
        relation: 'viewer',
        objectType: 'board',
        objectId: fixture.boardId,
        expiresAt: null,
      },
      { userId: OWNER, requestId },
    );

    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Read only to them',
      description: null,
    });

    const viewer = await actorFor(fixture.orgId, VIEWER, 'member');

    // Reading is exactly what a viewer may do.
    const detail = await cards.getCard(viewer, { cardId: card.cardId });
    expect(detail.title).toBe('Read only to them');

    await expect(
      cards.updateCard(viewer, {
        cardId: card.cardId,
        version: detail.version,
        title: 'Edited anyway',
        description: null,
        dueDate: null,
        startDate: null,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      cards.moveCard(viewer, {
        cardId: card.cardId,
        targetListId: fixture.listId,
        beforeCardId: null,
        afterCardId: null,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses to assign a user who is not a member of the org', async () => {
    const fixture = await scaffold('work-assign');

    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Assignable',
      description: null,
    });

    /* MEMBER exists as a user but was never added to this org. A foreign id in
       `assignee_ids` leaks nothing by itself, but it flows into notification
       fanout and every "my cards" query that follows. */
    await expect(
      cards.assignCard(fixture.owner, { cardId: card.cardId, assigneeIds: [MEMBER] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('assigns a real member and records both sides of the change', async () => {
    const fixture = await scaffold('work-assign-ok');
    await members.addMember(
      fixture.orgId,
      { email: 'member@work.test', role: 'member' },
      { userId: OWNER, requestId },
    );

    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Assignable',
      description: null,
    });

    const result = await cards.assignCard(fixture.owner, {
      cardId: card.cardId,
      assigneeIds: [MEMBER],
    });
    expect(result.assigneeIds).toEqual([MEMBER]);

    const detail = await cards.getCard(fixture.owner, { cardId: card.cardId });
    expect(detail.assigneeIds).toEqual([MEMBER]);
  });
});

describe('archiving', () => {
  it('hides an archived card from the board', async () => {
    const fixture = await scaffold('work-archive');

    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Gone',
      description: null,
    });

    await cards.archiveCard(fixture.owner, { cardId: card.cardId, archived: true });
    expect(await cards.listCards(fixture.owner, { boardId: fixture.boardId })).toHaveLength(0);

    // Archive is restorable, unlike delete (§7.1).
    await cards.archiveCard(fixture.owner, { cardId: card.cardId, archived: false });
    expect(await cards.listCards(fixture.owner, { boardId: fixture.boardId })).toHaveLength(1);
  });

  it('refuses to archive a list that still holds cards', async () => {
    const fixture = await scaffold('work-archive-list');

    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Occupant',
      description: null,
    });

    /* Cascading would be an unbounded write behind one click, and restoring
       could not know which cards were already archived beforehand. */
    await expect(
      lists.archiveList(fixture.owner, { listId: fixture.listId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await cards.archiveCard(fixture.owner, { cardId: card.cardId, archived: true });
    await expect(
      lists.archiveList(fixture.owner, { listId: fixture.listId }),
    ).resolves.toMatchObject({ archived: true });
  });
});

describe('rich text', () => {
  it('stores a TipTap document and flattens it for search', async () => {
    const fixture = await scaffold('work-richtext');

    const description = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ship the ' },
            { type: 'text', text: 'thing', marks: [{ type: 'bold' }] },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Then tell everyone.' }] },
      ],
    };

    const card = await cards.createCard(fixture.owner, {
      listId: fixture.listId,
      title: 'Documented',
      description,
    });

    const stored = await withOrgScope(fixture.orgId, async (tx) =>
      tx
        .select({ text: schema.cards.descriptionText, json: schema.cards.description })
        .from(schema.cards),
    );

    // The flattened copy is what Phase 8 indexes; it must contain the words and
    // must not run two paragraphs together into one nonexistent word.
    expect(stored[0]?.text).toBe('Ship the thing\nThen tell everyone.');
    expect(stored[0]?.json).toMatchObject({ type: 'doc' });

    const detail = await cards.getCard(fixture.owner, { cardId: card.cardId });
    expect(detail.description).toMatchObject({ type: 'doc' });
  });
});
