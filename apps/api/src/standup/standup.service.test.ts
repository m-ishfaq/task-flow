import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  unsafeAsId,
  type BoardId,
  type CardId,
  type ListId,
  type OrgId,
  type ProjectId,
  type StatusId,
  type UserId,
} from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as projects from './../work/project.service.js';
import * as boards from './../work/board.service.js';
import * as lists from './../work/list.service.js';
import * as cards from './../work/card.service.js';
import * as statuses from './../work/status.service.js';
import * as sprints from './../work/sprint.service.js';
import type { WorkActor } from './../work/shared.js';
import { queryStandup } from './standup.service.js';

/**
 * The standup view's data (ai/phase-15-ai-copilot-and-permissions.md §5),
 * against real Postgres. The narration half (`narrate.ts`) is covered by
 * `router.test.ts`'s stubbed-fetch end-to-end test; this file is the
 * deterministic query logic underneath it.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee00-0000-7000-8000-000000000201');
const MEMBER = unsafeAsId<'UserId'>('0195ee00-0000-7000-8000-000000000202');
const GUEST = unsafeAsId<'UserId'>('0195ee00-0000-7000-8000-000000000203');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@standup.test'],
  [MEMBER, 'member@standup.test'],
  [GUEST, 'guest@standup.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee00-0000-7000-8000-0000000002ff');

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

interface Fixture {
  readonly orgId: OrgId;
  readonly owner: WorkActor;
  readonly projectId: ProjectId;
  readonly boardId: BoardId;
  readonly listId: ListId;
  readonly doneStatusId: StatusId;
  readonly doingStatusId: StatusId;
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
  const done = await statuses.createStatus(owner, {
    projectId: project.projectId,
    name: 'Done',
    category: 'done',
    color: '#16a34a',
    isDefault: false,
  });
  const doing = await statuses.createStatus(owner, {
    projectId: project.projectId,
    name: 'In Progress',
    category: 'active',
    color: '#3b82f6',
    isDefault: false,
  });

  return {
    orgId,
    owner,
    projectId: project.projectId,
    boardId: board.boardId,
    listId: list.listId,
    doneStatusId: done.statusId,
    doingStatusId: doing.statusId,
  };
}

async function makeCard(
  owner: WorkActor,
  fixture: Fixture,
  title: string,
): Promise<{ readonly cardId: CardId; readonly version: number }> {
  const card = await cards.createCard(owner, { listId: fixture.listId, title, description: null });
  return { cardId: card.cardId, version: 1 };
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-standup-svc-test' });
});

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

describe('queryStandup', () => {
  it('buckets a member’s cards into yesterday / today / overdue', async () => {
    const fixture = await scaffold('standup-buckets');
    await members.addMember(
      fixture.orgId,
      { email: 'member@standup.test', role: 'member' },
      { userId: OWNER, requestId },
    );

    const doneCard = await makeCard(fixture.owner, fixture, 'Shipped it');
    await cards.assignCard(fixture.owner, { cardId: doneCard.cardId, assigneeIds: [MEMBER] });
    await cards.setCardStatus(fixture.owner, {
      cardId: doneCard.cardId,
      statusId: fixture.doneStatusId,
    });

    // Active status — this is what makes a card "today", not merely "not done".
    const activeCard = await makeCard(fixture.owner, fixture, 'In progress, no due date');
    await cards.assignCard(fixture.owner, { cardId: activeCard.cardId, assigneeIds: [MEMBER] });
    await cards.setCardStatus(fixture.owner, {
      cardId: activeCard.cardId,
      statusId: fixture.doingStatusId,
    });

    // Untouched backlog — not_started, never assigned an active status. Must
    // NOT appear in "today": a standup is not the place for the whole backlog.
    const backlogCard = await makeCard(fixture.owner, fixture, 'Untouched backlog item');
    await cards.assignCard(fixture.owner, { cardId: backlogCard.cardId, assigneeIds: [MEMBER] });

    const overdueCard = await makeCard(fixture.owner, fixture, 'Overdue');
    await cards.assignCard(fixture.owner, { cardId: overdueCard.cardId, assigneeIds: [MEMBER] });
    const overdueDetail = await cards.getCard(fixture.owner, { cardId: overdueCard.cardId });
    await cards.updateCard(fixture.owner, {
      cardId: overdueCard.cardId,
      version: overdueDetail.version,
      title: overdueDetail.title,
      description: null,
      dueDate: new Date('2020-01-01T00:00:00.000Z'),
      startDate: null,
      priority: null,
    });

    const result = await queryStandup(fixture.owner, { projectId: fixture.projectId });
    const member = result.members.find((entry) => entry.userId === MEMBER);
    expect(member).toBeDefined();
    expect(member?.yesterday.map((card) => card.cardId)).toEqual([doneCard.cardId]);
    expect(member?.today.map((card) => card.cardId)).toEqual([activeCard.cardId]);
    expect(member?.overdue.map((card) => card.cardId)).toEqual([overdueCard.cardId]);
    // Neither the done card nor the untouched backlog card show up in "today".
    expect(member?.today.map((card) => card.cardId)).not.toContain(doneCard.cardId);
    expect(member?.today.map((card) => card.cardId)).not.toContain(backlogCard.cardId);
  });

  it('reports urgent/high priority separately from overdue, and never both for the same card', async () => {
    const fixture = await scaffold('standup-urgent');
    const urgentCard = await makeCard(fixture.owner, fixture, 'Needs eyes now');
    await cards.assignCard(fixture.owner, { cardId: urgentCard.cardId, assigneeIds: [OWNER] });
    const urgentDetail = await cards.getCard(fixture.owner, { cardId: urgentCard.cardId });
    await cards.updateCard(fixture.owner, {
      cardId: urgentCard.cardId,
      version: urgentDetail.version,
      title: urgentDetail.title,
      description: null,
      dueDate: null,
      startDate: null,
      priority: 'urgent',
    });

    // Both overdue AND urgent-priority — must land in `overdue` only, never
    // double-counted into `urgent` too (standup.service.ts's own header).
    const overdueUrgentCard = await makeCard(fixture.owner, fixture, 'Overdue and urgent');
    await cards.assignCard(fixture.owner, {
      cardId: overdueUrgentCard.cardId,
      assigneeIds: [OWNER],
    });
    const overdueUrgentDetail = await cards.getCard(fixture.owner, {
      cardId: overdueUrgentCard.cardId,
    });
    await cards.updateCard(fixture.owner, {
      cardId: overdueUrgentCard.cardId,
      version: overdueUrgentDetail.version,
      title: overdueUrgentDetail.title,
      description: null,
      dueDate: new Date('2020-01-01T00:00:00.000Z'),
      startDate: null,
      priority: 'urgent',
    });

    const result = await queryStandup(fixture.owner, { projectId: fixture.projectId });
    const ownerEntry = result.members.find((entry) => entry.userId === OWNER);
    expect(ownerEntry?.urgent.map((card) => card.cardId)).toEqual([urgentCard.cardId]);
    expect(ownerEntry?.overdue.map((card) => card.cardId)).toEqual([overdueUrgentCard.cardId]);
  });

  it('a card with two assignees appears in both members’ buckets', async () => {
    const fixture = await scaffold('standup-multi-assignee');
    await members.addMember(
      fixture.orgId,
      { email: 'member@standup.test', role: 'member' },
      { userId: OWNER, requestId },
    );

    const shared = await makeCard(fixture.owner, fixture, 'Pair-programmed');
    await cards.assignCard(fixture.owner, { cardId: shared.cardId, assigneeIds: [OWNER, MEMBER] });
    await cards.setCardStatus(fixture.owner, {
      cardId: shared.cardId,
      statusId: fixture.doingStatusId,
    });

    const result = await queryStandup(fixture.owner, { projectId: fixture.projectId });
    const ownerEntry = result.members.find((entry) => entry.userId === OWNER);
    const memberEntry = result.members.find((entry) => entry.userId === MEMBER);
    expect(ownerEntry?.today.map((card) => card.cardId)).toEqual([shared.cardId]);
    expect(memberEntry?.today.map((card) => card.cardId)).toEqual([shared.cardId]);
  });

  it('excludes a done card from "yesterday" once it falls outside the window', async () => {
    const fixture = await scaffold('standup-window');
    const card = await makeCard(fixture.owner, fixture, 'Done a while ago');
    await cards.setCardStatus(fixture.owner, {
      cardId: card.cardId,
      statusId: fixture.doneStatusId,
    });
    await cards.assignCard(fixture.owner, { cardId: card.cardId, assigneeIds: [OWNER] });

    // Backdate the row directly — the service has no way to do this itself,
    // and that is the point: `updated_at` is the only signal it has.
    await admin.setOrg(fixture.orgId);
    await admin.query(
      `UPDATE work.cards SET updated_at = now() - interval '3 days' WHERE id = $1`,
      [card.cardId],
    );
    await admin.setOrg(null);

    const result = await queryStandup(fixture.owner, {
      projectId: fixture.projectId,
      sinceHours: 24,
    });
    const ownerEntry = result.members.find((entry) => entry.userId === OWNER);
    expect(ownerEntry?.yesterday).toEqual([]);
  });

  it('shows the active sprint’s urgent/high cards, never a done one', async () => {
    const fixture = await scaffold('standup-sprint');
    const sprint = await sprints.createSprint(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Sprint 1',
      goal: null,
      startsOn: '2026-08-10',
      endsOn: '2026-08-21',
    });
    await sprints.startSprint(fixture.owner, { sprintId: sprint.sprintId });

    const urgent = await makeCard(fixture.owner, fixture, 'On fire');
    await sprints.assignSprint(fixture.owner, { cardId: urgent.cardId, sprintId: sprint.sprintId });
    const urgentDetail = await cards.getCard(fixture.owner, { cardId: urgent.cardId });
    await cards.updateCard(fixture.owner, {
      cardId: urgent.cardId,
      version: urgentDetail.version,
      title: urgentDetail.title,
      description: null,
      dueDate: null,
      startDate: null,
      priority: 'urgent',
    });

    const urgentButDone = await makeCard(fixture.owner, fixture, 'Was on fire, now out');
    await sprints.assignSprint(fixture.owner, {
      cardId: urgentButDone.cardId,
      sprintId: sprint.sprintId,
    });
    const doneDetail = await cards.getCard(fixture.owner, { cardId: urgentButDone.cardId });
    await cards.updateCard(fixture.owner, {
      cardId: urgentButDone.cardId,
      version: doneDetail.version,
      title: doneDetail.title,
      description: null,
      dueDate: null,
      startDate: null,
      priority: 'urgent',
    });
    await cards.setCardStatus(fixture.owner, {
      cardId: urgentButDone.cardId,
      statusId: fixture.doneStatusId,
    });

    const normal = await makeCard(fixture.owner, fixture, 'Ordinary');
    await sprints.assignSprint(fixture.owner, { cardId: normal.cardId, sprintId: sprint.sprintId });

    const result = await queryStandup(fixture.owner, { projectId: fixture.projectId });
    expect(result.sprint?.sprintId).toBe(sprint.sprintId);
    expect(result.urgentSprintCards.map((card) => card.cardId)).toEqual([urgent.cardId]);
  });

  it('answers no sprint and no urgent cards when nothing is active', async () => {
    const fixture = await scaffold('standup-no-sprint');
    const result = await queryStandup(fixture.owner, { projectId: fixture.projectId });
    expect(result.sprint).toBeNull();
    expect(result.urgentSprintCards).toEqual([]);
  });

  it('refuses a caller who cannot read the project', async () => {
    /* NOT_FOUND, not FORBIDDEN — refusing the READ permission itself answers
       with the code that reveals less, per `packages/policy/src/enforce.ts`'s
       own `denialFor`: confirming "you may not read this" would itself
       confirm the project exists. */
    const fixture = await scaffold('standup-forbidden');
    await members.addMember(
      fixture.orgId,
      { email: 'guest@standup.test', role: 'guest' },
      { userId: OWNER, requestId },
    );
    const guest = await actorFor(fixture.orgId, GUEST, 'guest');

    await expect(queryStandup(guest, { projectId: fixture.projectId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
