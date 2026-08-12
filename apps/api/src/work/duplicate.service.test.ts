import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  unsafeAsId,
  type BoardId,
  type ListId,
  type OrgId,
  type ProjectId,
  type UserId,
} from '@taskflow/contracts';
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
import * as statuses from './status.service.js';
import * as labels from './label.service.js';
import * as sprints from './sprint.service.js';
import * as duplicate from './duplicate.service.js';
import type { WorkActor } from './shared.js';

/**
 * Duplicating a project (`duplicate.service.ts`).
 *
 * What these assert is not "rows were copied" but the properties that make a
 * copy USABLE: that the new project's children point at the new project's own
 * vocabulary rather than the source's, that its card-number namespace starts
 * fresh and continues correctly, and that everything the service documents as
 * deliberately-not-copied genuinely is not.
 *
 * The id-remapping assertions are the important ones. A copy that inserted the
 * right number of rows while leaving a card's `statusId` pointing at the SOURCE
 * project's status would look correct in every count, render plausibly, and be
 * wrong in a way that only surfaces when someone edits the original.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee00-0000-7000-8000-000000000301');

const requestId = unsafeAsId<'RequestId'>('0195ee00-0000-7000-8000-0000000003ff');

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
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.checklist_items WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.checklists WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.card_labels WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.custom_field_values WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.custom_field_defs WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.labels WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.statuses WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [orgId]);
  /* Children before parents — sprints reference their project. */
  await admin.query(`DELETE FROM work.sprints WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.views WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

interface Fixture {
  readonly orgId: OrgId;
  readonly owner: WorkActor;
  readonly projectId: ProjectId;
  readonly boardId: BoardId;
  readonly todoId: ListId;
  readonly doingId: ListId;
}

/** A project with two lists, two statuses, two labels, and three cards. */
async function scaffold(slug: string): Promise<Fixture> {
  const orgId = await newOrg(slug);
  const owner = await actorFor(orgId, OWNER, 'owner');

  const project = await projects.createProject(owner, {
    name: 'Website',
    key: 'WEB',
    description: 'The original description',
  });
  const board = await boards.createBoard(owner, {
    projectId: project.projectId,
    name: 'Delivery',
  });
  const todo = await lists.createList(owner, {
    boardId: board.boardId,
    name: 'Todo',
    wipLimit: null,
  });
  const doing = await lists.createList(owner, {
    boardId: board.boardId,
    name: 'Doing',
    wipLimit: 3,
  });

  await statuses.createStatus(owner, {
    projectId: project.projectId,
    name: 'Backlog',
    category: 'not_started',
    color: '#94a3b8',
    isDefault: true,
  });
  const done = await statuses.createStatus(owner, {
    projectId: project.projectId,
    name: 'Done',
    category: 'done',
    color: '#16a34a',
    isDefault: false,
  });

  const bug = await labels.createLabel(owner, {
    projectId: project.projectId,
    name: 'Bug',
    color: '#ef4444',
  });
  await labels.createLabel(owner, {
    projectId: project.projectId,
    name: 'Feature',
    color: '#3b82f6',
  });

  const first = await cards.createCard(owner, {
    listId: todo.listId,
    title: 'First',
    description: null,
  });
  await cards.createCard(owner, { listId: todo.listId, title: 'Second', description: null });
  await cards.createCard(owner, { listId: doing.listId, title: 'Third', description: null });

  await cards.setCardStatus(owner, { cardId: first.cardId, statusId: done.statusId });
  await labels.setCardLabels(owner, { cardId: first.cardId, labelIds: [bug.labelId] });

  return {
    orgId,
    owner,
    projectId: project.projectId,
    boardId: board.boardId,
    todoId: todo.listId,
    doingId: doing.listId,
  };
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, $2, $2, now())`,
    [OWNER, 'owner@duplicate.test'],
  );

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-duplicate-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.end();
});

describe('duplicateProject', () => {
  it('copies structure and cards, and reports the counts', async () => {
    const fixture = await scaffold('dup-full');

    const result = await duplicate.duplicateProject(fixture.owner, {
      sourceProjectId: fixture.projectId,
      name: 'Website (copy)',
      key: 'WEB2',
      includeCards: true,
    });

    expect(result).toMatchObject({ key: 'WEB2', boards: 1, lists: 2, cards: 3 });

    const copiedBoards = await boards.listBoards(fixture.owner, {
      projectId: result.projectId,
      includeArchived: false,
    });
    expect(copiedBoards).toHaveLength(1);

    const copiedCards = await cards.listCards(fixture.owner, {
      boardId: copiedBoards[0]?.boardId as BoardId,
    });
    expect(copiedCards.map((card) => card.title).sort()).toEqual(['First', 'Second', 'Third']);

    /* The source is untouched — a duplicate is a read of it. */
    const original = await cards.listCards(fixture.owner, { boardId: fixture.boardId });
    expect(original).toHaveLength(3);
  });

  it('points copied cards at the COPY’s vocabulary, not the source’s', async () => {
    /* THE ASSERTION THAT MATTERS. A copy that inserted every row correctly but
       left `statusId` pointing at the source project's status would pass every
       count, render plausibly, and be wrong in a way that only surfaces when
       someone edits or deletes the original's vocabulary. */
    const fixture = await scaffold('dup-remap');

    const result = await duplicate.duplicateProject(fixture.owner, {
      sourceProjectId: fixture.projectId,
      name: 'Remapped',
      key: 'REM',
      includeCards: true,
    });

    const sourceStatuses = await statuses.listStatuses(fixture.owner, {
      projectId: fixture.projectId,
    });
    const copyStatuses = await statuses.listStatuses(fixture.owner, {
      projectId: result.projectId,
    });
    const sourceIds = new Set(sourceStatuses.map((status) => status.statusId));

    expect(copyStatuses.map((status) => status.name).sort()).toEqual(['Backlog', 'Done']);
    /* Same names, entirely different ids. */
    expect(copyStatuses.some((status) => sourceIds.has(status.statusId))).toBe(false);

    const copiedBoards = await boards.listBoards(fixture.owner, {
      projectId: result.projectId,
      includeArchived: false,
    });
    const copiedCards = await cards.listCards(fixture.owner, {
      boardId: copiedBoards[0]?.boardId as BoardId,
    });

    const withStatus = copiedCards.find((card) => card.title === 'First');
    expect(withStatus?.statusId).not.toBeNull();
    /* And it is one of the COPY's statuses. */
    expect(copyStatuses.map((status) => status.statusId)).toContain(withStatus?.statusId);
  });

  it('renumbers cards from 1 and leaves the counter ready for the next one', async () => {
    /* A copied card keeping `WEB-142` would make that reference name a card in
       two projects, which is the one thing a card number must not do. And the
       counter must continue the new namespace, or the next card created by
       hand collides with a copied one. */
    const fixture = await scaffold('dup-numbers');

    const result = await duplicate.duplicateProject(fixture.owner, {
      sourceProjectId: fixture.projectId,
      name: 'Numbered',
      key: 'NUM',
      includeCards: true,
    });

    const copiedBoards = await boards.listBoards(fixture.owner, {
      projectId: result.projectId,
      includeArchived: false,
    });
    const boardId = copiedBoards[0]?.boardId as BoardId;
    const copied = await cards.listCards(fixture.owner, { boardId });
    expect(copied.map((card) => card.reference).sort()).toEqual(['NUM-1', 'NUM-2', 'NUM-3']);

    /* The next hand-made card continues rather than collides. */
    const listsOfCopy = await lists.listLists(fixture.owner, { boardId });
    const next = await cards.createCard(fixture.owner, {
      listId: listsOfCopy[0]?.listId as ListId,
      title: 'Made after the copy',
      description: null,
    });
    const detail = await cards.getCard(fixture.owner, { cardId: next.cardId });
    expect(detail.reference).toBe('NUM-4');
  });

  it('copies the shape only when includeCards is false', async () => {
    const fixture = await scaffold('dup-shape');

    const result = await duplicate.duplicateProject(fixture.owner, {
      sourceProjectId: fixture.projectId,
      name: 'Template',
      key: 'TPL',
      includeCards: false,
    });

    expect(result.cards).toBe(0);
    expect(result.lists).toBe(2);

    const copiedBoards = await boards.listBoards(fixture.owner, {
      projectId: result.projectId,
      includeArchived: false,
    });
    const copied = await cards.listCards(fixture.owner, {
      boardId: copiedBoards[0]?.boardId as BoardId,
    });
    expect(copied).toEqual([]);

    /* The vocabulary still came across — that is what makes it a template. */
    const copyLabels = await labels.listLabels(fixture.owner, { projectId: result.projectId });
    expect(copyLabels.map((label) => label.name).sort()).toEqual(['Bug', 'Feature']);
  });

  it('does not copy sprints — a fork starts planning fresh', async () => {
    const fixture = await scaffold('dup-sprints');
    const sprint = await sprints.createSprint(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Sprint 1',
      goal: null,
      startsOn: '2026-08-10',
      endsOn: '2026-08-21',
    });
    await sprints.startSprint(fixture.owner, { sprintId: sprint.sprintId });

    const result = await duplicate.duplicateProject(fixture.owner, {
      sourceProjectId: fixture.projectId,
      name: 'No sprints',
      key: 'NOS',
      includeCards: true,
    });

    expect(await sprints.listSprints(fixture.owner, { projectId: result.projectId })).toEqual([]);
  });

  it('refuses a key another project already holds', async () => {
    const fixture = await scaffold('dup-key');

    await expect(
      duplicate.duplicateProject(fixture.owner, {
        sourceProjectId: fixture.projectId,
        name: 'Clash',
        key: 'WEB',
        includeCards: false,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a source in another org', async () => {
    const mine = await scaffold('dup-mine');
    const theirs = await scaffold('dup-theirs');

    await expect(
      duplicate.duplicateProject(mine.owner, {
        sourceProjectId: theirs.projectId,
        name: 'Stolen',
        key: 'STL',
        includeCards: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
