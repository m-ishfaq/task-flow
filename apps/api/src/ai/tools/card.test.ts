import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type RequestId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../../testing/fixtures.js';
import * as orgs from '../../tenancy/org.service.js';
import { loadTuples } from '../../tenancy/resolve.js';
import * as projects from '../../work/project.service.js';
import * as boards from '../../work/board.service.js';
import * as lists from '../../work/list.service.js';
import * as statuses from '../../work/status.service.js';
import * as cardsSvc from '../../work/card.service.js';
import * as labelsSvc from '../../work/label.service.js';
import * as sprintsSvc from '../../work/sprint.service.js';
import type { WorkActor } from '../../work/shared.js';
import {
  createCardAddLabelsTool,
  createCardAssignTool,
  createCardCreateTool,
  createCardSetStatusTool,
  createCardUpdateTool,
} from './card.js';
import type { ToolContext } from './registry.js';

/**
 * The single-card write tools (§4.1, §4.3 Wave 2), against real Postgres.
 *
 * The property that matters most: every tool reaches the SAME `can()`
 * check a human's own click would — proven here by actually calling a
 * `guest` (who holds none of these permissions by design) through the
 * tool and asserting it refuses, exactly like `card.service.test.ts`'s own
 * authorization assertions would for a route. Everything else proves the
 * tool wraps the real service faithfully: `card_update`'s read-then-patch
 * (a caller naming only `priority` must not erase the title), and
 * `card_assign`'s additive semantics (must never drop an existing
 * assignee the caller did not mention).
 */

const OWNER = unsafeAsId<'UserId'>('0195f400-0000-7000-8000-000000000001');
const requestId: RequestId = unsafeAsId<'RequestId'>('0195f400-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
let created: OrgId[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  /* Cards first: `cards_sprint_fk` means a sprint cannot go while cards
     still point at it. Sprints before projects: `sprints_project_fk` — the
     same ordering sprint.service.test.ts's own removeOrg already
     documents. */
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.sprints WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

async function ownerSubject(orgId: OrgId): Promise<Subject> {
  const tuples = await loadTuples(orgId, OWNER);
  return { orgId, userId: OWNER, role: 'owner', tuples };
}

async function ownerActor(orgId: OrgId): Promise<WorkActor> {
  return { subject: await ownerSubject(orgId), requestId };
}

function guestCtx(orgId: OrgId): ToolContext {
  return { subject: { orgId, userId: OWNER, role: 'guest', tuples: [] }, requestId };
}

function ownerCtx(subject: Subject): ToolContext {
  return { subject, requestId };
}

async function seedList(orgId: OrgId): Promise<{
  readonly actor: WorkActor;
  readonly projectId: string;
  readonly listId: string;
}> {
  const actor = await ownerActor(orgId);
  const project = await projects.createProject(actor, {
    name: 'Website',
    key: 'WEB',
    description: null,
  });
  const board = await boards.createBoard(actor, { projectId: project.projectId, name: 'Delivery' });
  const list = await lists.createList(actor, {
    boardId: board.boardId,
    name: 'Todo',
    wipLimit: null,
  });
  return { actor, projectId: project.projectId, listId: list.listId };
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'owner@ai-card-tools.test', 'owner@ai-card-tools.test', now())`,
    [OWNER],
  );

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'ai-card-tools-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.end();
  await closeDatabase();
});

describe('card_create', () => {
  it('creates a real card for an owner', async () => {
    const orgId = await newOrg('card-create-owner');
    const { listId } = await seedList(orgId);
    const subject = await ownerSubject(orgId);

    const tool = createCardCreateTool();
    const result = await tool.execute(ownerCtx(subject), {
      listId,
      title: 'Fix login bug',
      description: 'Users cannot log in on Safari.',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { cardId: string; reference: string };
    expect(parsed.reference).toBe('WEB-1');

    await admin.setOrg(orgId);
    const rows = await admin.query(`SELECT title, description FROM work.cards WHERE id = $1`, [
      parsed.cardId,
    ]);
    await admin.setOrg(null);
    expect(rows.rows[0]?.['title']).toBe('Fix login bug');
  });

  it('refuses a guest, who holds card:create from no role by design', async () => {
    const orgId = await newOrg('card-create-guest');
    const { listId } = await seedList(orgId);

    const tool = createCardCreateTool();
    const result = await tool.execute(guestCtx(orgId), { listId, title: 'Should not exist' });

    expect(result.isError).toBe(true);

    await admin.setOrg(orgId);
    const rows = await admin.query(`SELECT id FROM work.cards WHERE org_id = $1`, [orgId]);
    await admin.setOrg(null);
    expect(rows.rowCount).toBe(0);
  });

  it('declares requiresConfirmation: true', () => {
    expect(createCardCreateTool().requiresConfirmation).toBe(true);
  });

  it('sets assignees, labels, priority, due date, and sprint in ONE call — no follow-up round trips', async () => {
    const orgId = await newOrg('card-create-full');
    const { actor, listId, projectId } = await seedList(orgId);
    const subject = await ownerSubject(orgId);

    const bug = await labelsSvc.createLabel(actor, {
      projectId: unsafeAsId<'ProjectId'>(projectId),
      name: 'Bug',
      color: '#dc2626',
    });
    const sprint = await sprintsSvc.createSprint(actor, {
      projectId: unsafeAsId<'ProjectId'>(projectId),
      name: 'Sprint 1',
      goal: null,
      startsOn: '2026-08-10',
      endsOn: '2026-08-21',
    });

    const tool = createCardCreateTool();
    const result = await tool.execute(ownerCtx(subject), {
      listId,
      title: 'Fully specified card',
      assigneeIds: [OWNER],
      labelIds: [bug.labelId],
      priority: 'high',
      dueDate: '2030-01-15T00:00:00.000Z',
      sprintId: sprint.sprintId,
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { cardId: string; warnings?: readonly string[] };
    expect(parsed.warnings).toBeUndefined();

    const after = await cardsSvc.getCard(actor, {
      cardId: unsafeAsId<'CardId'>(parsed.cardId),
    });
    expect(after.assigneeIds).toEqual([OWNER]);
    expect(after.priority).toBe('high');
    expect(after.dueDate?.toISOString()).toBe('2030-01-15T00:00:00.000Z');
    expect(after.sprintId).toBe(sprint.sprintId);

    const labels = await labelsSvc.listCardLabels(actor, {
      cardId: unsafeAsId<'CardId'>(parsed.cardId),
    });
    expect(labels.map((label) => label.labelId)).toEqual([bug.labelId]);
  });

  it('still creates the card and reports what failed when a follow-up field is invalid', async () => {
    const orgId = await newOrg('card-create-partial-failure');
    const { listId } = await seedList(orgId);
    const subject = await ownerSubject(orgId);
    const notAMember = unsafeAsId<'UserId'>('0195f400-0000-7000-8000-0000000000aa');

    const tool = createCardCreateTool();
    const result = await tool.execute(ownerCtx(subject), {
      listId,
      title: 'Card with a bad assignee',
      assigneeIds: [notAMember],
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      cardId: string;
      reference: string;
      warnings?: readonly string[];
    };
    expect(parsed.reference).toBe('WEB-1');
    expect(parsed.warnings?.[0]).toMatch(/Could not set assignees/);

    await admin.setOrg(orgId);
    const rows = await admin.query(`SELECT id FROM work.cards WHERE id = $1`, [parsed.cardId]);
    await admin.setOrg(null);
    expect(rows.rowCount).toBe(1);
  });
});

describe('card_update', () => {
  it('patches only the named fields, leaving everything else — including title — unchanged', async () => {
    const orgId = await newOrg('card-update-patch');
    const { actor, listId } = await seedList(orgId);
    const created = await cardsSvc.createCard(actor, {
      listId: unsafeAsId<'ListId'>(listId),
      title: 'Original title',
      description: null,
    });
    const subject = await ownerSubject(orgId);

    const tool = createCardUpdateTool();
    const result = await tool.execute(ownerCtx(subject), {
      cardId: created.cardId,
      priority: 'high',
    });

    expect(result.isError).toBeUndefined();

    const after = await cardsSvc.getCard(actor, { cardId: created.cardId });
    expect(after.title).toBe('Original title');
    expect(after.priority).toBe('high');
  });

  it('refuses a guest', async () => {
    const orgId = await newOrg('card-update-guest');
    const { actor, listId } = await seedList(orgId);
    const created = await cardsSvc.createCard(actor, {
      listId: unsafeAsId<'ListId'>(listId),
      title: 'Original title',
      description: null,
    });

    const tool = createCardUpdateTool();
    const result = await tool.execute(guestCtx(orgId), {
      cardId: created.cardId,
      priority: 'urgent',
    });

    expect(result.isError).toBe(true);
    const after = await cardsSvc.getCard(actor, { cardId: created.cardId });
    expect(after.priority).toBeNull();
  });
});

describe('card_assign', () => {
  it('adds an assignee without removing an existing one', async () => {
    const orgId = await newOrg('card-assign-additive');
    const { actor, listId } = await seedList(orgId);
    const created = await cardsSvc.createCard(actor, {
      listId: unsafeAsId<'ListId'>(listId),
      title: 'Needs two owners',
      description: null,
    });
    await cardsSvc.assignCard(actor, { cardId: created.cardId, assigneeIds: [OWNER] });

    // A second member, so assigning them proves the ADD half.
    const SECOND = unsafeAsId<'UserId'>('0195f400-0000-7000-8000-000000000002');
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, 'second@ai-card-tools.test', 'second@ai-card-tools.test', now())
       ON CONFLICT (id) DO NOTHING`,
      [SECOND],
    );
    await admin.setOrg(orgId);
    await admin.query(
      `INSERT INTO identity.memberships (id, org_id, user_id, role, status)
       VALUES (gen_random_uuid(), $1, $2, 'member', 'active')`,
      [orgId, SECOND],
    );
    await admin.setOrg(null);

    const subject = await ownerSubject(orgId);
    const tool = createCardAssignTool();
    const result = await tool.execute(ownerCtx(subject), {
      cardId: created.cardId,
      assigneeIds: [SECOND],
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { assigneeIds: readonly string[] };
    expect(new Set(parsed.assigneeIds)).toEqual(new Set([OWNER, SECOND]));
  });
});

describe('card_set_status', () => {
  it('moves a card to a real status', async () => {
    const orgId = await newOrg('card-set-status');
    const { actor, listId, projectId } = await seedList(orgId);
    const created = await cardsSvc.createCard(actor, {
      listId: unsafeAsId<'ListId'>(listId),
      title: 'Needs a status',
      description: null,
    });
    const status = await statuses.createStatus(actor, {
      projectId: unsafeAsId<'ProjectId'>(projectId),
      name: 'In Review',
      category: 'active',
      color: '#00ff00',
      isDefault: false,
    });

    const subject = await ownerSubject(orgId);
    const tool = createCardSetStatusTool();
    const result = await tool.execute(ownerCtx(subject), {
      cardId: created.cardId,
      statusId: status.statusId,
    });

    expect(result.isError).toBeUndefined();
    const after = await cardsSvc.getCard(actor, { cardId: created.cardId });
    expect(after.statusId).toBe(status.statusId);
  });

  it('refuses a guest', async () => {
    const orgId = await newOrg('card-set-status-guest');
    const { actor, listId } = await seedList(orgId);
    const created = await cardsSvc.createCard(actor, {
      listId: unsafeAsId<'ListId'>(listId),
      title: 'Should stay unset',
      description: null,
    });

    const tool = createCardSetStatusTool();
    const result = await tool.execute(guestCtx(orgId), {
      cardId: created.cardId,
      statusId: null,
    });

    expect(result.isError).toBe(true);
  });
});

describe('card_add_labels', () => {
  it('adds a label without removing one already on the card', async () => {
    const orgId = await newOrg('card-add-labels-additive');
    const { actor, listId, projectId } = await seedList(orgId);
    const created = await cardsSvc.createCard(actor, {
      listId: unsafeAsId<'ListId'>(listId),
      title: 'Needs two labels',
      description: null,
    });
    const bug = await labelsSvc.createLabel(actor, {
      projectId: unsafeAsId<'ProjectId'>(projectId),
      name: 'Bug',
      color: '#dc2626',
    });
    const urgent = await labelsSvc.createLabel(actor, {
      projectId: unsafeAsId<'ProjectId'>(projectId),
      name: 'Urgent',
      color: '#f97316',
    });
    await labelsSvc.setCardLabels(actor, { cardId: created.cardId, labelIds: [bug.labelId] });

    const subject = await ownerSubject(orgId);
    const tool = createCardAddLabelsTool();
    const result = await tool.execute(ownerCtx(subject), {
      cardId: created.cardId,
      labelIds: [urgent.labelId],
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { labelIds: readonly string[] };
    expect(new Set(parsed.labelIds)).toEqual(new Set([bug.labelId, urgent.labelId]));
  });

  it('refuses a guest', async () => {
    const orgId = await newOrg('card-add-labels-guest');
    const { actor, listId, projectId } = await seedList(orgId);
    const created = await cardsSvc.createCard(actor, {
      listId: unsafeAsId<'ListId'>(listId),
      title: 'Should stay unlabeled',
      description: null,
    });
    const bug = await labelsSvc.createLabel(actor, {
      projectId: unsafeAsId<'ProjectId'>(projectId),
      name: 'Bug',
      color: '#dc2626',
    });

    const tool = createCardAddLabelsTool();
    const result = await tool.execute(guestCtx(orgId), {
      cardId: created.cardId,
      labelIds: [bug.labelId],
    });

    expect(result.isError).toBe(true);
    const labels = await labelsSvc.listCardLabels(actor, { cardId: created.cardId });
    expect(labels).toEqual([]);
  });

  it('declares requiresConfirmation: true', () => {
    expect(createCardAddLabelsTool().requiresConfirmation).toBe(true);
  });
});
