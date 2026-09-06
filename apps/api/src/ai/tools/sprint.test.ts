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
import * as cardsSvc from '../../work/card.service.js';
import { createSprint as createSprintSvc } from '../../work/sprint.service.js';
import type { WorkActor } from '../../work/shared.js';
import { createSprintAddCardsTool, createSprintCreateTool } from './sprint.js';
import type { ToolContext } from './registry.js';

/**
 * Sprint planning tools (§4.1, §4.3 Wave 3), against real Postgres.
 *
 * `sprint_add_cards` is the interesting property to prove: it loops the
 * real per-card `assignSprint` rather than a bulk mutation, and this file
 * proves it reports each card's OWN outcome instead of aborting the whole
 * batch on the first failure — one nonexistent card id must not also
 * silently drop a valid one from the same call.
 */

const OWNER = unsafeAsId<'UserId'>('0195f500-0000-7000-8000-000000000001');
const requestId: RequestId = unsafeAsId<'RequestId'>('0195f500-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
let created: OrgId[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

/**
 * Children before parents (`work.service.test.ts`'s own `removeOrg` and
 * `tenancy-seed.ts`'s `clearTenant` document the same ordering): a sprint
 * this file creates leaves a `work.sprints` row referencing `work.projects`
 * with no ON DELETE CASCADE between them, so deleting the org straight
 * through (as `card.test.ts`'s simpler fixture — no sprints — can get away
 * with) hits `sprints_project_fk`.
 */
async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.sprints WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.statuses WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.views WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
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

async function seedList(
  orgId: OrgId,
): Promise<{ readonly actor: WorkActor; readonly projectId: string; readonly listId: string }> {
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
     VALUES ($1, 'owner@ai-sprint-tools.test', 'owner@ai-sprint-tools.test', now())`,
    [OWNER],
  );

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'ai-sprint-tools-test' });
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

describe('sprint_create', () => {
  it('plans a real sprint for an owner', async () => {
    const orgId = await newOrg('sprint-create-owner');
    const { projectId } = await seedList(orgId);
    const subject = await ownerSubject(orgId);

    const tool = createSprintCreateTool();
    const result = await tool.execute(ownerCtx(subject), {
      projectId,
      name: 'Sprint 14',
      startsOn: '2026-09-07',
      endsOn: '2026-09-20',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { sprintId: string };

    await admin.setOrg(orgId);
    const rows = await admin.query(`SELECT name, status FROM work.sprints WHERE id = $1`, [
      parsed.sprintId,
    ]);
    await admin.setOrg(null);
    expect(rows.rows[0]).toMatchObject({ name: 'Sprint 14', status: 'planned' });
  });

  it('refuses a guest', async () => {
    const orgId = await newOrg('sprint-create-guest');
    const { projectId } = await seedList(orgId);

    const tool = createSprintCreateTool();
    const result = await tool.execute(guestCtx(orgId), {
      projectId,
      name: 'Should not exist',
      startsOn: '2026-09-07',
      endsOn: '2026-09-20',
    });

    expect(result.isError).toBe(true);

    await admin.setOrg(orgId);
    const rows = await admin.query(`SELECT id FROM work.sprints WHERE org_id = $1`, [orgId]);
    await admin.setOrg(null);
    expect(rows.rowCount).toBe(0);
  });

  it('declares requiresConfirmation: true', () => {
    expect(createSprintCreateTool().requiresConfirmation).toBe(true);
  });

  it('rejects a not-really-a-date string before it ever reaches the service', async () => {
    const orgId = await newOrg('sprint-create-bad-date');
    const { projectId } = await seedList(orgId);
    const subject = await ownerSubject(orgId);

    const tool = createSprintCreateTool();
    const result = await tool.execute(ownerCtx(subject), {
      projectId,
      name: 'Sprint X',
      startsOn: '2026-02-30',
      endsOn: '2026-03-10',
    });

    expect(result.isError).toBe(true);
  });
});

describe('sprint_add_cards', () => {
  it('adds every card and reports success for each', async () => {
    const orgId = await newOrg('sprint-add-cards-success');
    const { actor, listId, projectId } = await seedList(orgId);
    const sprint = await createSprintSvc(actor, {
      projectId: unsafeAsId<'ProjectId'>(projectId),
      name: 'Sprint 1',
      goal: null,
      startsOn: '2026-09-07',
      endsOn: '2026-09-20',
    });
    const cardA = await cardsSvc.createCard(actor, {
      listId: unsafeAsId<'ListId'>(listId),
      title: 'Card A',
      description: null,
    });
    const cardB = await cardsSvc.createCard(actor, {
      listId: unsafeAsId<'ListId'>(listId),
      title: 'Card B',
      description: null,
    });

    const subject = await ownerSubject(orgId);
    const tool = createSprintAddCardsTool();
    const result = await tool.execute(ownerCtx(subject), {
      sprintId: sprint.sprintId,
      cardIds: [cardA.cardId, cardB.cardId],
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      succeeded: readonly string[];
      failed: readonly { cardId: string; reason: string }[];
    };
    expect(new Set(parsed.succeeded)).toEqual(new Set([cardA.cardId, cardB.cardId]));
    expect(parsed.failed).toEqual([]);

    const afterA = await cardsSvc.getCard(actor, { cardId: cardA.cardId });
    expect(afterA.sprintId).toBe(sprint.sprintId);
  });

  it('reports a per-card failure without dropping the cards that succeeded', async () => {
    const orgId = await newOrg('sprint-add-cards-partial');
    const { actor, listId, projectId } = await seedList(orgId);
    const sprint = await createSprintSvc(actor, {
      projectId: unsafeAsId<'ProjectId'>(projectId),
      name: 'Sprint 1',
      goal: null,
      startsOn: '2026-09-07',
      endsOn: '2026-09-20',
    });
    const cardA = await cardsSvc.createCard(actor, {
      listId: unsafeAsId<'ListId'>(listId),
      title: 'Card A',
      description: null,
    });
    const bogusCardId = unsafeAsId<'CardId'>('0195f500-dead-7000-8000-000000000099');

    const subject = await ownerSubject(orgId);
    const tool = createSprintAddCardsTool();
    const result = await tool.execute(ownerCtx(subject), {
      sprintId: sprint.sprintId,
      cardIds: [cardA.cardId, bogusCardId],
    });

    // At least one card succeeded, so the overall result is not an error —
    // the model needs to see BOTH the success and the one failure, not a
    // blanket refusal that reads as "nothing happened".
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      succeeded: readonly string[];
      failed: readonly { cardId: string; reason: string }[];
    };
    expect(parsed.succeeded).toEqual([cardA.cardId]);
    expect(parsed.failed).toHaveLength(1);
    expect(parsed.failed[0]?.cardId).toBe(bogusCardId);

    const afterA = await cardsSvc.getCard(actor, { cardId: cardA.cardId });
    expect(afterA.sprintId).toBe(sprint.sprintId);
  });

  it('refuses a guest for every card', async () => {
    const orgId = await newOrg('sprint-add-cards-guest');
    const { actor, listId, projectId } = await seedList(orgId);
    const sprint = await createSprintSvc(actor, {
      projectId: unsafeAsId<'ProjectId'>(projectId),
      name: 'Sprint 1',
      goal: null,
      startsOn: '2026-09-07',
      endsOn: '2026-09-20',
    });
    const cardA = await cardsSvc.createCard(actor, {
      listId: unsafeAsId<'ListId'>(listId),
      title: 'Card A',
      description: null,
    });

    const tool = createSprintAddCardsTool();
    const result = await tool.execute(guestCtx(orgId), {
      sprintId: sprint.sprintId,
      cardIds: [cardA.cardId],
    });

    expect(result.isError).toBe(true);
    const afterA = await cardsSvc.getCard(actor, { cardId: cardA.cardId });
    expect(afterA.sprintId).toBeNull();
  });

  it('declares requiresConfirmation: true', () => {
    expect(createSprintAddCardsTool().requiresConfirmation).toBe(true);
  });
});
