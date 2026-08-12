import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  unsafeAsId,
  type BoardId,
  type CardId,
  type ListId,
  type OrgId,
  type ProjectId,
  type SprintId,
  type StatusId,
  type UserId,
} from '@taskflow/contracts';
import { closeDatabase, eq, initializeDatabase, schema, withOrgScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as projects from './project.service.js';
import * as boards from './board.service.js';
import * as lists from './list.service.js';
import * as cards from './card.service.js';
import * as statuses from './status.service.js';
import * as sprints from './sprint.service.js';
import {
  cardSprintChanged,
  sprintCancelled,
  sprintCompleted,
  sprintCreated,
  sprintStarted,
  sprintUpdated,
} from './events.js';
import type { WorkActor } from './shared.js';

/**
 * Sprints (`ai/phase-10.5-sprints.md`) — the lifecycle, the closure semantics
 * of decision 5, and the Phase-3 permission split, against real Postgres.
 *
 * The properties asserted here are the ones only a real execution demonstrates:
 * the partial unique index refusing a second active sprint, the composite FK
 * refusing a card assigned to another project's sprint, the close transaction
 * splitting done from unfinished cards atomically, and the event batch that
 * records the close.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee00-0000-7000-8000-000000000101');
const MEMBER = unsafeAsId<'UserId'>('0195ee00-0000-7000-8000-000000000102');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@sprint.test'],
  [MEMBER, 'member@sprint.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee00-0000-7000-8000-0000000001ff');

let admin: AdminConnection;
let created: OrgId[] = [];

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
  /* Dispatch rows before outbox rows — the FK points from dispatch to outbox.
     The relay never runs inside tests so none accumulate, but a future
     consumer change should not turn teardown into a confusing failure. */
  await admin.query(
    `DELETE FROM platform.outbox_dispatch WHERE event_id IN
       (SELECT id FROM platform.outbox WHERE org_id = $1)`,
    [orgId],
  );
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  /* Cards first: `cards_sprint_fk` means a sprint cannot go while cards still
     point at it. Sprints before projects: `sprints_project_fk`. */
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.sprints WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.statuses WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.views WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.team_members WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.teams WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

/** The org's outbox rows, name + payload, newest last — for event assertions. */
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

/**
 * The value of a card's `sprint_id` column, read as the migrator.
 *
 * The migrator is not RLS-exempt, so the read must run under the org the row
 * belongs to — the same discipline `removeOrg` follows. Reading without the
 * scope would silently return zero rows and a null here.
 */
async function sprintOf(orgId: OrgId, cardId: string): Promise<string | null> {
  await admin.setOrg(orgId);
  const rows = await admin.query(`SELECT sprint_id FROM work.cards WHERE id = $1`, [cardId]);
  await admin.setOrg(null);
  const value = rows.rows[0]?.['sprint_id'];
  return typeof value === 'string' ? value : null;
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
  const board = await boards.createBoard(owner, {
    projectId: project.projectId,
    name: 'Delivery',
  });
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
): Promise<{ cardId: CardId }> {
  const card = await cards.createCard(owner, {
    listId: fixture.listId,
    title,
    description: null,
  });
  return { cardId: card.cardId };
}

/** A planned sprint in the fixture's project, ready to start. */
async function makeSprint(
  owner: WorkActor,
  fixture: Fixture,
  name = 'Sprint 1',
): Promise<{ sprintId: SprintId }> {
  return sprints.createSprint(owner, {
    projectId: fixture.projectId,
    name,
    goal: null,
    startsOn: '2026-08-10',
    endsOn: '2026-08-21',
  });
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-sprint-svc-test' });
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
});

describe('lifecycle', () => {
  it('creates a planned sprint and emits sprint.created', async () => {
    const fixture = await scaffold('sprint-create');
    const sprint = await makeSprint(fixture.owner, fixture, 'Launch');

    const events = await outboxFor(fixture.orgId);
    const created = events.filter((event) => event.name === sprintCreated.name);
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toMatchObject({
      sprintId: sprint.sprintId,
      projectId: fixture.projectId,
      name: 'Launch',
      startsOn: '2026-08-10',
      endsOn: '2026-08-21',
    });

    const list = await sprints.listSprints(fixture.owner, { projectId: fixture.projectId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      sprintId: sprint.sprintId,
      status: 'planned',
      cardCount: 0,
    });
  });

  it('refuses dates that end before they start', async () => {
    const fixture = await scaffold('sprint-bad-dates');
    await expect(
      sprints.createSprint(fixture.owner, {
        projectId: fixture.projectId,
        name: 'Backwards',
        goal: null,
        startsOn: '2026-08-21',
        endsOn: '2026-08-10',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('walks planned → active → completed, refusing the invalid transitions', async () => {
    const fixture = await scaffold('sprint-lifecycle');
    const { sprintId } = await makeSprint(fixture.owner, fixture);

    // A planned sprint cannot be completed — it was never started.
    await expect(sprints.completeSprint(fixture.owner, { sprintId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    await expect(sprints.startSprint(fixture.owner, { sprintId })).resolves.toEqual({
      status: 'active',
    });

    const startedEvents = await outboxFor(fixture.orgId);
    const started = startedEvents.filter((event) => event.name === sprintStarted.name);
    expect(started).toHaveLength(1);
    expect(started[0]?.payload).toMatchObject({ sprintId, projectId: fixture.projectId });

    // An active sprint cannot be started again.
    await expect(sprints.startSprint(fixture.owner, { sprintId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    await expect(sprints.completeSprint(fixture.owner, { sprintId })).resolves.toMatchObject({
      status: 'completed',
      shippedCount: 0,
      releasedCount: 0,
    });

    // A completed sprint is a record: it cannot restart and it cannot re-close.
    await expect(sprints.startSprint(fixture.owner, { sprintId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(sprints.completeSprint(fixture.owner, { sprintId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('refuses a second active sprint in the same project', async () => {
    const fixture = await scaffold('sprint-one-active');
    const first = await makeSprint(fixture.owner, fixture, 'First');
    const second = await makeSprint(fixture.owner, fixture, 'Second');

    await expect(sprints.startSprint(fixture.owner, { sprintId: first.sprintId })).resolves.toEqual(
      {
        status: 'active',
      },
    );

    // The service message...
    await expect(
      sprints.startSprint(fixture.owner, { sprintId: second.sprintId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // ...and the index as the backstop, driven directly as the app role. The
    // SQLSTATE lives on the wrapped query error's `cause`.
    await withOrgScope(fixture.orgId, async (tx) => {
      await expect(
        tx
          .update(schema.sprints)
          .set({ status: 'active', startedAt: new Date() })
          .where(eq(schema.sprints.id, second.sprintId)),
      ).rejects.toMatchObject({ cause: { code: '23505' } });
    });
  });

  it('cancels a planned or active sprint but not a completed one', async () => {
    const fixture = await scaffold('sprint-cancel');
    const planned = await makeSprint(fixture.owner, fixture, 'Planned');
    await expect(
      sprints.cancelSprint(fixture.owner, { sprintId: planned.sprintId }),
    ).resolves.toMatchObject({ status: 'cancelled', releasedCount: 0 });

    const active = await makeSprint(fixture.owner, fixture, 'Active');
    await sprints.startSprint(fixture.owner, { sprintId: active.sprintId });
    await expect(
      sprints.cancelSprint(fixture.owner, { sprintId: active.sprintId }),
    ).resolves.toMatchObject({ status: 'cancelled', releasedCount: 0 });

    await expect(
      sprints.cancelSprint(fixture.owner, { sprintId: active.sprintId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('lists the active sprint first, then planned in date order', async () => {
    const fixture = await scaffold('sprint-order');
    const later = await sprints.createSprint(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Later',
      goal: null,
      startsOn: '2026-09-01',
      endsOn: '2026-09-12',
    });
    const sooner = await sprints.createSprint(fixture.owner, {
      projectId: fixture.projectId,
      name: 'Sooner',
      goal: null,
      startsOn: '2026-08-24',
      endsOn: '2026-09-04',
    });
    await sprints.startSprint(fixture.owner, { sprintId: sooner.sprintId });

    const list = await sprints.listSprints(fixture.owner, { projectId: fixture.projectId });
    expect(list.map((sprint) => sprint.sprintId)).toEqual([sooner.sprintId, later.sprintId]);
  });
});

describe('closure semantics (decision 5)', () => {
  it('keeps done cards, releases unfinished ones, and reports both counts', async () => {
    const fixture = await scaffold('sprint-close');
    const { sprintId } = await makeSprint(fixture.owner, fixture);
    await sprints.startSprint(fixture.owner, { sprintId });

    const shipped = await makeCard(fixture.owner, fixture, 'Shipped');
    const unfinished = await makeCard(fixture.owner, fixture, 'Unfinished');
    const alsoShipped = await makeCard(fixture.owner, fixture, 'Also shipped');
    await cards.setCardStatus(fixture.owner, {
      cardId: shipped.cardId,
      statusId: fixture.doneStatusId,
    });
    await cards.setCardStatus(fixture.owner, {
      cardId: alsoShipped.cardId,
      statusId: fixture.doneStatusId,
    });
    await cards.setCardStatus(fixture.owner, {
      cardId: unfinished.cardId,
      statusId: fixture.doingStatusId,
    });

    await sprints.assignSprint(fixture.owner, { cardId: shipped.cardId, sprintId });
    await sprints.assignSprint(fixture.owner, { cardId: unfinished.cardId, sprintId });
    await sprints.assignSprint(fixture.owner, { cardId: alsoShipped.cardId, sprintId });

    const result = await sprints.completeSprint(fixture.owner, { sprintId });
    expect(result).toEqual({ status: 'completed', shippedCount: 2, releasedCount: 1 });

    // Done cards keep the sprint as the record of what shipped; the rest go
    // back to the backlog (sprint_id IS NULL — the backlog is not a row).
    await expect(sprintOf(fixture.orgId, shipped.cardId)).resolves.toBe(sprintId);
    await expect(sprintOf(fixture.orgId, alsoShipped.cardId)).resolves.toBe(sprintId);
    await expect(sprintOf(fixture.orgId, unfinished.cardId)).resolves.toBeNull();

    const events = await outboxFor(fixture.orgId);
    const closed = events.filter((event) => event.name === sprintCompleted.name);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.payload).toMatchObject({
      sprintId,
      shippedCount: 2,
      releasedCount: 1,
    });

    // The close is a batch of membership changes: one per released card, each
    // saying it left this sprint for the backlog. The three ASSIGN events
    // (before null) are not releases — filter on the direction.
    const releasedEvents = events.filter(
      (event) => event.name === cardSprintChanged.name && event.payload['after'] === null,
    );
    expect(releasedEvents).toHaveLength(1);
    expect(releasedEvents[0]?.payload).toMatchObject({
      cardId: unfinished.cardId,
      before: sprintId,
      after: null,
    });
  });

  it('cancellation releases every card, done ones included', async () => {
    const fixture = await scaffold('sprint-cancel-cards');
    const { sprintId } = await makeSprint(fixture.owner, fixture);
    await sprints.startSprint(fixture.owner, { sprintId });

    const done = await makeCard(fixture.owner, fixture, 'Done one');
    const other = await makeCard(fixture.owner, fixture, 'Other');
    await cards.setCardStatus(fixture.owner, {
      cardId: done.cardId,
      statusId: fixture.doneStatusId,
    });
    await sprints.assignSprint(fixture.owner, { cardId: done.cardId, sprintId });
    await sprints.assignSprint(fixture.owner, { cardId: other.cardId, sprintId });

    const result = await sprints.cancelSprint(fixture.owner, { sprintId });
    expect(result).toEqual({ status: 'cancelled', releasedCount: 2 });

    await expect(sprintOf(fixture.orgId, done.cardId)).resolves.toBeNull();
    await expect(sprintOf(fixture.orgId, other.cardId)).resolves.toBeNull();

    const events = await outboxFor(fixture.orgId);
    expect(events.filter((event) => event.name === sprintCancelled.name)).toHaveLength(1);
    /* Two assign events plus the two releases of the cancel. */
    expect(
      events.filter(
        (event) => event.name === cardSprintChanged.name && event.payload['after'] === null,
      ),
    ).toHaveLength(2);
  });
});

describe('membership', () => {
  it('assigns and releases a card, with before/after on the event and no-op saves silent', async () => {
    const fixture = await scaffold('sprint-membership');
    const { sprintId } = await makeSprint(fixture.owner, fixture);
    const card = await makeCard(fixture.owner, fixture, 'Mine');

    await expect(
      sprints.assignSprint(fixture.owner, { cardId: card.cardId, sprintId }),
    ).resolves.toEqual({ sprintId });

    let events = await outboxFor(fixture.orgId);
    let moved = events.filter((event) => event.name === cardSprintChanged.name);
    expect(moved).toHaveLength(1);
    expect(moved[0]?.payload).toMatchObject({ cardId: card.cardId, before: null, after: sprintId });

    // Assigning again is a no-op — no event, no audit noise.
    await sprints.assignSprint(fixture.owner, { cardId: card.cardId, sprintId });
    events = await outboxFor(fixture.orgId);
    expect(events.filter((event) => event.name === cardSprintChanged.name)).toHaveLength(1);

    await expect(sprints.releaseSprint(fixture.owner, { cardId: card.cardId })).resolves.toEqual({
      sprintId: null,
    });
    await expect(sprintOf(fixture.orgId, card.cardId)).resolves.toBeNull();

    events = await outboxFor(fixture.orgId);
    moved = events.filter((event) => event.name === cardSprintChanged.name);
    expect(moved).toHaveLength(2);
    expect(moved[1]?.payload).toMatchObject({ cardId: card.cardId, before: sprintId, after: null });

    // Releasing a backlog card is a no-op too.
    await sprints.releaseSprint(fixture.owner, { cardId: card.cardId });
    events = await outboxFor(fixture.orgId);
    expect(events.filter((event) => event.name === cardSprintChanged.name)).toHaveLength(2);
  });

  it('refuses a completed sprint and a cancelled one — the record stays stable', async () => {
    const fixture = await scaffold('sprint-closed-refuses');
    const completed = await makeSprint(fixture.owner, fixture, 'Closed');
    await sprints.startSprint(fixture.owner, { sprintId: completed.sprintId });
    await sprints.completeSprint(fixture.owner, { sprintId: completed.sprintId });

    const cancelled = await makeSprint(fixture.owner, fixture, 'Cancelled');
    await sprints.cancelSprint(fixture.owner, { sprintId: cancelled.sprintId });

    const card = await makeCard(fixture.owner, fixture, 'Late');
    await expect(
      sprints.assignSprint(fixture.owner, { cardId: card.cardId, sprintId: completed.sprintId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      sprints.assignSprint(fixture.owner, { cardId: card.cardId, sprintId: cancelled.sprintId }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a sprint from another project — the composite FK, translated to 404', async () => {
    const fixture = await scaffold('sprint-cross-project');
    const otherProject = await projects.createProject(fixture.owner, {
      name: 'Mobile',
      key: 'MOB',
      description: null,
    });
    const foreign = await sprints.createSprint(fixture.owner, {
      projectId: otherProject.projectId,
      name: 'Theirs',
      goal: null,
      startsOn: '2026-08-10',
      endsOn: '2026-08-21',
    });

    const card = await makeCard(fixture.owner, fixture, 'Ours');
    await expect(
      sprints.assignSprint(fixture.owner, { cardId: card.cardId, sprintId: foreign.sprintId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(sprintOf(fixture.orgId, card.cardId)).resolves.toBeNull();
  });

  it('edits a planned sprint fully, an active one only its goal, a completed one not at all', async () => {
    const fixture = await scaffold('sprint-edit');
    const { sprintId } = await makeSprint(fixture.owner, fixture);

    await expect(
      sprints.updateSprint(fixture.owner, {
        sprintId,
        name: 'Renamed',
        goal: 'Ship the thing',
        startsOn: '2026-08-11',
        endsOn: '2026-08-22',
      }),
    ).resolves.toEqual({ name: 'Renamed' });

    let events = await outboxFor(fixture.orgId);
    let updated = events.filter((event) => event.name === sprintUpdated.name);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.payload).toMatchObject({
      sprintId,
      before: { name: 'Sprint 1', goal: null },
      after: { name: 'Renamed', goal: 'Ship the thing' },
    });

    await sprints.startSprint(fixture.owner, { sprintId });

    // Active: goal only. The dates are the contract the burndown reads.
    await expect(
      sprints.updateSprint(fixture.owner, {
        sprintId,
        name: 'Renamed',
        goal: 'Ship it better',
        startsOn: '2026-08-11',
        endsOn: '2026-08-22',
      }),
    ).resolves.toEqual({ name: 'Renamed' });
    await expect(
      sprints.updateSprint(fixture.owner, {
        sprintId,
        name: 'Renamed Again',
        goal: 'Ship it better',
        startsOn: '2026-08-11',
        endsOn: '2026-08-22',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // A no-op save stays out of the audit log.
    events = await outboxFor(fixture.orgId);
    updated = events.filter((event) => event.name === sprintUpdated.name);
    expect(updated).toHaveLength(2);

    await sprints.completeSprint(fixture.owner, { sprintId });
    await expect(
      sprints.updateSprint(fixture.owner, {
        sprintId,
        name: 'History Rewriter',
        goal: null,
        startsOn: '2026-08-11',
        endsOn: '2026-08-22',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('close destination (10.6 D1 — supersedes 10.5 decision 5)', () => {
  it('moves unfinished cards into the NAMED sprint and keeps done ones', async () => {
    const fixture = await scaffold('close-into-next');
    const current = await makeSprint(fixture.owner, fixture, 'Sprint 1');
    const next = await makeSprint(fixture.owner, fixture, 'Sprint 2');
    await sprints.startSprint(fixture.owner, { sprintId: current.sprintId });

    const shipped = await makeCard(fixture.owner, fixture, 'Shipped');
    const unfinished = await makeCard(fixture.owner, fixture, 'Carried over');
    for (const card of [shipped, unfinished]) {
      await sprints.assignSprint(fixture.owner, {
        cardId: card.cardId,
        sprintId: current.sprintId,
      });
    }
    await cards.setCardStatus(fixture.owner, {
      cardId: shipped.cardId,
      statusId: fixture.doneStatusId,
    });

    const result = await sprints.completeSprint(fixture.owner, {
      sprintId: current.sprintId,
      moveUnfinishedTo: next.sprintId,
    });

    expect(result).toMatchObject({ shippedCount: 1, releasedCount: 1 });

    /* The done card stays with the sprint it shipped in — a completed
       sprint's record must not change because a later sprint was chosen. */
    const shippedCard = await cards.getCard(fixture.owner, { cardId: shipped.cardId });
    expect(shippedCard.sprintId).toBe(current.sprintId);

    const carried = await cards.getCard(fixture.owner, { cardId: unfinished.cardId });
    expect(carried.sprintId).toBe(next.sprintId);
  });

  it('still releases to the backlog when no destination is given', async () => {
    /* THE ADDITIVE ASSERTION. 10.5's behaviour must be byte-for-byte intact
       for a caller that passes nothing — that is what makes D1 a new option
       rather than a change of meaning, and it is the test that would fail if
       someone later made a destination mandatory. */
    const fixture = await scaffold('close-default-backlog');
    const sprint = await makeSprint(fixture.owner, fixture);
    await sprints.startSprint(fixture.owner, { sprintId: sprint.sprintId });

    const card = await makeCard(fixture.owner, fixture, 'Unfinished');
    await sprints.assignSprint(fixture.owner, { cardId: card.cardId, sprintId: sprint.sprintId });

    await sprints.completeSprint(fixture.owner, { sprintId: sprint.sprintId });

    const after = await cards.getCard(fixture.owner, { cardId: card.cardId });
    expect(after.sprintId).toBeNull();
  });

  it('refuses a destination in another project', async () => {
    /* The composite FK would refuse the write anyway — but as a 500. This
       proves the service turns it into a 404 BEFORE anything is written, so
       the sprint is not left completed with its cards stranded. */
    const fixture = await scaffold('close-cross-project');
    const other = await projects.createProject(fixture.owner, {
      name: 'Mobile',
      key: 'MOB',
      description: null,
    });
    const foreign = await sprints.createSprint(fixture.owner, {
      projectId: other.projectId,
      name: 'Their Sprint',
      goal: null,
      startsOn: '2026-08-10',
      endsOn: '2026-08-21',
    });

    const sprint = await makeSprint(fixture.owner, fixture);
    await sprints.startSprint(fixture.owner, { sprintId: sprint.sprintId });

    await expect(
      sprints.completeSprint(fixture.owner, {
        sprintId: sprint.sprintId,
        moveUnfinishedTo: foreign.sprintId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    /* And the sprint is still running — the refusal wrote nothing. */
    const [row] = await sprints.listSprints(fixture.owner, { projectId: fixture.projectId });
    expect(row?.status).toBe('active');
  });

  it('refuses a completed destination', async () => {
    const fixture = await scaffold('close-into-completed');
    const old = await makeSprint(fixture.owner, fixture, 'Old');
    await sprints.startSprint(fixture.owner, { sprintId: old.sprintId });
    await sprints.completeSprint(fixture.owner, { sprintId: old.sprintId });

    const current = await makeSprint(fixture.owner, fixture, 'Current');
    await sprints.startSprint(fixture.owner, { sprintId: current.sprintId });

    /* Moving live work into a closed sprint would make its shipped record
       grow after the fact. */
    await expect(
      sprints.completeSprint(fixture.owner, {
        sprintId: current.sprintId,
        moveUnfinishedTo: old.sprintId,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses rolling a sprint into itself', async () => {
    const fixture = await scaffold('close-into-self');
    const sprint = await makeSprint(fixture.owner, fixture);
    await sprints.startSprint(fixture.owner, { sprintId: sprint.sprintId });

    await expect(
      sprints.completeSprint(fixture.owner, {
        sprintId: sprint.sprintId,
        moveUnfinishedTo: sprint.sprintId,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('listActiveSprints — the sidebar line (10.6 D3)', () => {
  it('returns nothing when a project has no active sprint', async () => {
    const fixture = await scaffold('active-none');
    /* A planned sprint is NOT active. The sidebar must stay silent for a
       project that has lined work up but not started it — a line that appeared
       early would claim a sprint is running when it is not. */
    await makeSprint(fixture.owner, fixture);

    expect(await sprints.listActiveSprints(fixture.owner)).toEqual([]);
  });

  it('returns the active sprint with its live card count', async () => {
    const fixture = await scaffold('active-one');
    const sprint = await makeSprint(fixture.owner, fixture);
    await sprints.startSprint(fixture.owner, { sprintId: sprint.sprintId });

    const first = await makeCard(fixture.owner, fixture, 'One');
    const second = await makeCard(fixture.owner, fixture, 'Two');
    await sprints.assignSprint(fixture.owner, {
      cardId: first.cardId,
      sprintId: sprint.sprintId,
    });
    await sprints.assignSprint(fixture.owner, {
      cardId: second.cardId,
      sprintId: sprint.sprintId,
    });

    const active = await sprints.listActiveSprints(fixture.owner);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      projectId: fixture.projectId,
      sprintId: sprint.sprintId,
      name: 'Sprint 1',
      cardCount: 2,
    });
  });

  it('counts only live cards — an archived card leaves the count', async () => {
    const fixture = await scaffold('active-archived');
    const sprint = await makeSprint(fixture.owner, fixture);
    await sprints.startSprint(fixture.owner, { sprintId: sprint.sprintId });

    const card = await makeCard(fixture.owner, fixture, 'Archived later');
    await sprints.assignSprint(fixture.owner, { cardId: card.cardId, sprintId: sprint.sprintId });
    expect((await sprints.listActiveSprints(fixture.owner))[0]?.cardCount).toBe(1);

    await cards.archiveCard(fixture.owner, { cardId: card.cardId, archived: true });
    /* Archiving is not deleting, and the board still shows the card under a
       filter — but the sidebar's number is the live count, the same one the
       picker shows. Asserted because "count everything attached" and "count
       what is on the board" are both defensible and only one matches. */
    const after = await sprints.listActiveSprints(fixture.owner);
    expect(after[0]?.cardCount).toBe(1);
  });

  it('returns one row per project — two projects both running a sprint', async () => {
    /* The one-active index is per PROJECT, not per org (0054). An
       implementation that assumed one active sprint per org would return one
       row here and silently hide the other team's sprint. */
    const fixture = await scaffold('active-two-projects');
    const second = await projects.createProject(fixture.owner, {
      name: 'Mobile',
      key: 'MOB',
      description: null,
    });

    const one = await makeSprint(fixture.owner, fixture, 'Web Sprint');
    await sprints.startSprint(fixture.owner, { sprintId: one.sprintId });

    const two = await sprints.createSprint(fixture.owner, {
      projectId: second.projectId,
      name: 'Mobile Sprint',
      goal: null,
      startsOn: '2026-08-10',
      endsOn: '2026-08-21',
    });
    await sprints.startSprint(fixture.owner, { sprintId: two.sprintId });

    const active = await sprints.listActiveSprints(fixture.owner);
    expect(active).toHaveLength(2);
    expect(active.map((row) => row.name).sort()).toEqual(['Mobile Sprint', 'Web Sprint']);
  });

  it('never returns another org’s sprint', async () => {
    const mine = await scaffold('active-mine');
    const theirs = await scaffold('active-theirs');

    const sprint = await makeSprint(theirs.owner, theirs, 'Their Sprint');
    await sprints.startSprint(theirs.owner, { sprintId: sprint.sprintId });

    /* RLS, not a WHERE clause — `withOrgScope` is the whole isolation
       argument, and a cross-org read returns zero rows rather than erroring. */
    expect(await sprints.listActiveSprints(mine.owner)).toEqual([]);
    expect(await sprints.listActiveSprints(theirs.owner)).toHaveLength(1);
  });

  it('drops the line when the sprint completes', async () => {
    const fixture = await scaffold('active-completed');
    const sprint = await makeSprint(fixture.owner, fixture);
    await sprints.startSprint(fixture.owner, { sprintId: sprint.sprintId });
    expect(await sprints.listActiveSprints(fixture.owner)).toHaveLength(1);

    await sprints.completeSprint(fixture.owner, { sprintId: sprint.sprintId });
    expect(await sprints.listActiveSprints(fixture.owner)).toEqual([]);
  });
});

describe('authorization', () => {
  it("lets a member assign their own cards but not manage the project's sprints", async () => {
    const fixture = await scaffold('sprint-authz');
    await members.addMember(
      fixture.orgId,
      { email: 'member@sprint.test', role: 'member' },
      { userId: OWNER, requestId },
    );
    const member = await actorFor(fixture.orgId, MEMBER, 'member');

    const { sprintId } = await makeSprint(fixture.owner, fixture);
    const card = await makeCard(fixture.owner, fixture, 'Team card');

    // Moving ONE card into a sprint is editing that card — a member may.
    await expect(sprints.assignSprint(member, { cardId: card.cardId, sprintId })).resolves.toEqual({
      sprintId,
    });
    await expect(sprintOf(fixture.orgId, card.cardId)).resolves.toBe(sprintId);

    // Managing the project's planning structure is editing the project — not.
    await expect(
      sprints.createSprint(member, {
        projectId: fixture.projectId,
        name: 'Mine',
        goal: null,
        startsOn: '2026-08-10',
        endsOn: '2026-08-21',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(sprints.startSprint(member, { sprintId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(sprints.completeSprint(member, { sprintId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(sprints.cancelSprint(member, { sprintId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      sprints.updateSprint(member, {
        sprintId,
        name: 'Renamed',
        goal: null,
        startsOn: '2026-08-10',
        endsOn: '2026-08-21',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // The list read is the picker's — a member may see the sprint it is in.
    await expect(
      sprints.listSprints(member, { projectId: fixture.projectId }),
    ).resolves.toHaveLength(1);
  });
});
