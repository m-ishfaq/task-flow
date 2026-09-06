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
import * as labelsSvc from '../../work/label.service.js';
import * as sprintsSvc from '../../work/sprint.service.js';
import * as cardsSvc from '../../work/card.service.js';
import type { WorkActor } from '../../work/shared.js';
import {
  createFindCardTool,
  createListBoardsTool,
  createListLabelsTool,
  createListMembersTool,
  createListProjectsTool,
  createListSprintsTool,
} from './lookup.js';
import type { ToolContext } from './registry.js';

/**
 * The lookup tools (`list_projects`/`list_boards`/`list_labels`) — see
 * `lookup.ts`'s own header for why they exist: nothing else in the
 * registry could ever resolve a project/board/list/label NAME to the id
 * every write tool actually requires.
 */

const OWNER = unsafeAsId<'UserId'>('0195f700-0000-7000-8000-000000000001');
const requestId: RequestId = unsafeAsId<'RequestId'>('0195f700-0000-7000-8000-0000000000ff');

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
  // Children before parents: work.sprints has no ON DELETE CASCADE to
  // work.projects, the identical fixture-ordering fix
  // work.service.test.ts's own removeOrg and sprint.service.test.ts already
  // document. work.cards needed the same fix the moment this file started
  // creating one (find_card), the identical ordering card.test.ts's own
  // removeOrg already carries.
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

function ownerCtx(subject: Subject): ToolContext {
  return { subject, requestId };
}

function guestCtx(orgId: OrgId): ToolContext {
  return { subject: { orgId, userId: OWNER, role: 'guest', tuples: [] }, requestId };
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'owner@ai-lookup-tools.test', 'owner@ai-lookup-tools.test', now())`,
    [OWNER],
  );

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'ai-lookup-tools-test' });
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

describe('list_projects', () => {
  it('reports a real project by name', async () => {
    const orgId = await newOrg('lookup-projects');
    const actor = await ownerActor(orgId);
    await projects.createProject(actor, { name: 'Website', key: 'WEB', description: null });

    const tool = createListProjectsTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {});

    const parsed = JSON.parse(result.content) as readonly { name: string; key: string }[];
    expect(parsed).toEqual([expect.objectContaining({ name: 'Website', key: 'WEB' })]);
  });

  it('reports no projects for a fresh org', async () => {
    const orgId = await newOrg('lookup-projects-empty');

    const tool = createListProjectsTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {});

    expect(result.content).toBe('No projects exist yet.');
  });
});

describe('list_boards', () => {
  it('nests each board’s lists, so one call resolves project name -> list id', async () => {
    const orgId = await newOrg('lookup-boards');
    const actor = await ownerActor(orgId);
    const project = await projects.createProject(actor, {
      name: 'Website',
      key: 'WEB',
      description: null,
    });
    const board = await boards.createBoard(actor, {
      projectId: project.projectId,
      name: 'Delivery',
    });
    await lists.createList(actor, { boardId: board.boardId, name: 'Todo', wipLimit: null });

    const tool = createListBoardsTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {
      projectId: project.projectId,
    });

    const parsed = JSON.parse(result.content) as readonly {
      name: string;
      lists: readonly { name: string }[];
    }[];
    expect(parsed).toEqual([
      expect.objectContaining({
        name: 'Delivery',
        lists: [expect.objectContaining({ name: 'Todo' })],
      }),
    ]);
  });

  it('reports no boards for an empty project', async () => {
    const orgId = await newOrg('lookup-boards-empty');
    const actor = await ownerActor(orgId);
    const project = await projects.createProject(actor, {
      name: 'Website',
      key: 'WEB',
      description: null,
    });

    const tool = createListBoardsTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {
      projectId: project.projectId,
    });

    expect(result.content).toBe('This project has no boards.');
  });
});

describe('list_labels', () => {
  it('reports a real label by name', async () => {
    const orgId = await newOrg('lookup-labels');
    const actor = await ownerActor(orgId);
    const project = await projects.createProject(actor, {
      name: 'Website',
      key: 'WEB',
      description: null,
    });
    await labelsSvc.createLabel(actor, {
      projectId: project.projectId,
      name: 'Bug',
      color: '#dc2626',
    });

    const tool = createListLabelsTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {
      projectId: project.projectId,
    });

    const parsed = JSON.parse(result.content) as readonly { name: string }[];
    expect(parsed).toEqual([expect.objectContaining({ name: 'Bug' })]);
  });

  it('reports no labels for a project with none defined', async () => {
    const orgId = await newOrg('lookup-labels-empty');
    const actor = await ownerActor(orgId);
    const project = await projects.createProject(actor, {
      name: 'Website',
      key: 'WEB',
      description: null,
    });

    const tool = createListLabelsTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {
      projectId: project.projectId,
    });

    expect(result.content).toBe('This project has no labels defined yet.');
  });
});

describe('list_members', () => {
  it('reports the org owner by name and email', async () => {
    const orgId = await newOrg('lookup-members');

    const tool = createListMembersTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {});

    const parsed = JSON.parse(result.content) as readonly {
      userId: string;
      name: string;
      email: string;
    }[];
    expect(parsed).toEqual([
      expect.objectContaining({ userId: OWNER, email: 'owner@ai-lookup-tools.test' }),
    ]);
  });

  it('refuses a guest, who holds member:read from no role by design', async () => {
    const orgId = await newOrg('lookup-members-guest');

    const tool = createListMembersTool();
    const result = await tool.execute(guestCtx(orgId), {});

    expect(result.isError).toBe(true);
  });
});

describe('list_sprints', () => {
  it('reports a real sprint by name', async () => {
    const orgId = await newOrg('lookup-sprints-real');
    const actor = await ownerActor(orgId);
    const project = await projects.createProject(actor, {
      name: 'Website',
      key: 'WEB',
      description: null,
    });
    await sprintsSvc.createSprint(actor, {
      projectId: project.projectId,
      name: 'Sprint 1',
      goal: null,
      startsOn: '2026-08-10',
      endsOn: '2026-08-21',
    });

    const tool = createListSprintsTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {
      projectId: project.projectId,
    });

    const parsed = JSON.parse(result.content) as readonly { name: string; status: string }[];
    expect(parsed).toEqual([expect.objectContaining({ name: 'Sprint 1', status: 'planned' })]);
  });

  it('reports no sprints for a project with none defined', async () => {
    const orgId = await newOrg('lookup-sprints-none');
    const actor = await ownerActor(orgId);
    const project = await projects.createProject(actor, {
      name: 'Website',
      key: 'WEB',
      description: null,
    });

    const tool = createListSprintsTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {
      projectId: project.projectId,
    });

    expect(result.content).toBe('This project has no sprints yet.');
  });
});

describe('find_card', () => {
  async function seedCard(orgId: OrgId): Promise<{ readonly cardId: string }> {
    const actor = await ownerActor(orgId);
    const project = await projects.createProject(actor, {
      name: 'Website',
      key: 'WEB',
      description: null,
    });
    const board = await boards.createBoard(actor, {
      projectId: project.projectId,
      name: 'Delivery',
    });
    const list = await lists.createList(actor, {
      boardId: board.boardId,
      name: 'Todo',
      wipLimit: null,
    });
    const created = await cardsSvc.createCard(actor, {
      listId: list.listId,
      title: 'Fix login bug',
      description: null,
    });
    return { cardId: created.cardId };
  }

  it('resolves a real reference to its cardId', async () => {
    const orgId = await newOrg('lookup-find-card');
    const { cardId } = await seedCard(orgId);

    const tool = createFindCardTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {
      reference: 'WEB-1',
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { cardId: string; reference: string };
    expect(parsed).toEqual(expect.objectContaining({ cardId, reference: 'WEB-1' }));
  });

  it('is case-insensitive on the project key, matching how a person actually types it', async () => {
    const orgId = await newOrg('lookup-find-card-case');
    const { cardId } = await seedCard(orgId);

    const tool = createFindCardTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {
      reference: 'web-1',
    });

    const parsed = JSON.parse(result.content) as { cardId: string };
    expect(parsed.cardId).toBe(cardId);
  });

  it('reports an error, never a crash, for a reference that does not exist', async () => {
    const orgId = await newOrg('lookup-find-card-missing');
    await seedCard(orgId);

    const tool = createFindCardTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {
      reference: 'WEB-999',
    });

    expect(result.isError).toBe(true);
  });

  it('reports an error for text that is not a valid reference shape at all', async () => {
    const orgId = await newOrg('lookup-find-card-malformed');

    const tool = createFindCardTool();
    const result = await tool.execute(ownerCtx(await ownerSubject(orgId)), {
      reference: 'not a reference',
    });

    expect(result.isError).toBe(true);
  });
});
