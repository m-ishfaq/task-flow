import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  unsafeAsId,
  type ListId,
  type OrgId,
  type ProjectId,
  type RequestId,
} from '@taskflow/contracts';
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
import type { WorkActor } from '../../work/shared.js';
import { createMyCardsTool } from './my-cards.js';
import type { ToolContext } from './registry.js';

/**
 * The `my_cards` tool (see its own header for why it exists at all — a real
 * transcript where `search` could not answer "what are my pending tasks").
 * The property that matters most here: a DONE card must never appear in the
 * result, proven by actually moving a card to a `done`-category status and
 * asserting it disappears — the exact classification this tool exists to
 * do deterministically rather than leave to the model.
 */

const OWNER = unsafeAsId<'UserId'>('0195f600-0000-7000-8000-000000000001');
const requestId: RequestId = unsafeAsId<'RequestId'>('0195f600-0000-7000-8000-0000000000ff');

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

function ownerCtx(subject: Subject): ToolContext {
  return { subject, requestId };
}

async function seedList(
  orgId: OrgId,
): Promise<{ readonly actor: WorkActor; readonly projectId: ProjectId; readonly listId: ListId }> {
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
     VALUES ($1, 'owner@ai-my-cards-tool.test', 'owner@ai-my-cards-tool.test', now())`,
    [OWNER],
  );

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'ai-my-cards-tool-test' });
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

describe('my_cards', () => {
  it('reports a card assigned to the caller', async () => {
    const orgId = await newOrg('my-cards-basic');
    const { actor, listId } = await seedList(orgId);
    const card = await cardsSvc.createCard(actor, {
      listId,
      title: 'Fix login bug',
      description: null,
    });
    await cardsSvc.assignCard(actor, { cardId: card.cardId, assigneeIds: [OWNER] });

    const tool = createMyCardsTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as readonly { reference: string; title: string }[];
    expect(parsed.map((entry) => entry.title)).toEqual(['Fix login bug']);
  });

  it('excludes a card once its status category is done — the deterministic filter this tool exists for', async () => {
    const orgId = await newOrg('my-cards-done');
    const { actor, listId, projectId } = await seedList(orgId);
    const card = await cardsSvc.createCard(actor, {
      listId,
      title: 'Already shipped',
      description: null,
    });
    await cardsSvc.assignCard(actor, { cardId: card.cardId, assigneeIds: [OWNER] });
    const done = await statuses.createStatus(actor, {
      projectId,
      name: 'Done',
      category: 'done',
      color: '#16a34a',
      isDefault: false,
    });
    await cardsSvc.setCardStatus(actor, { cardId: card.cardId, statusId: done.statusId });

    const tool = createMyCardsTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {});

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('Nothing pending — every card assigned to the user is done.');
  });

  it('reports "no cards" for a member with nothing assigned', async () => {
    const orgId = await newOrg('my-cards-empty');
    await seedList(orgId);

    const tool = createMyCardsTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {});

    expect(result.content).toBe('No cards are assigned to the user.');
  });

  it('a card left in an active (not-done) status still appears, with its due date', async () => {
    const orgId = await newOrg('my-cards-active');
    const { actor, listId, projectId } = await seedList(orgId);
    const card = await cardsSvc.createCard(actor, {
      listId,
      title: 'Still in progress',
      description: null,
    });
    await cardsSvc.assignCard(actor, { cardId: card.cardId, assigneeIds: [OWNER] });
    const active = await statuses.createStatus(actor, {
      projectId,
      name: 'In Progress',
      category: 'active',
      color: '#3b82f6',
      isDefault: false,
    });
    await cardsSvc.setCardStatus(actor, { cardId: card.cardId, statusId: active.statusId });
    const detail = await cardsSvc.getCard(actor, { cardId: card.cardId });
    await cardsSvc.updateCard(actor, {
      cardId: card.cardId,
      version: detail.version,
      title: detail.title,
      description: null,
      dueDate: new Date('2030-01-15T00:00:00.000Z'),
      startDate: null,
      priority: 'high',
    });

    const tool = createMyCardsTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {});

    const parsed = JSON.parse(result.content) as readonly {
      cardId: string;
      reference: string;
      title: string;
      dueDate: string | null;
      priority: string | null;
    }[];
    expect(parsed).toEqual([
      {
        cardId: card.cardId,
        reference: 'WEB-1',
        title: 'Still in progress',
        priority: 'high',
        dueDate: '2030-01-15T00:00:00.000Z',
      },
    ]);
  });
});
