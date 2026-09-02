import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import {
  closeDatabase,
  initializeAuditDatabase,
  initializeDatabase,
  schema,
  withOrgScope,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import {
  queryVelocity,
  queryBurndown,
  queryCfd,
  queryCycleTime,
  queryWorkload,
  queryVolume,
} from './dashboard.service.js';

/**
 * Integration tests for the analytics dashboard queries (Phase 11 Wave 3),
 * against real Postgres with fixture data.
 *
 * Dashboards read from pre-computed rollup tables (rollup_velocity,
 * rollup_cfd, rollup_cycle_time, rollup_volume). Tests insert directly
 * into these rollup tables to test query logic independently of the
 * refresh service. The burndown query still reads card_transitions
 * directly (sprint filtering requires it).
 */

const APP_URL = 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test';
const AUDIT_URL = 'postgresql://taskflow_audit:audit-dev-secret@localhost:5433/taskflow_test';

let admin: AdminConnection;
let created: OrgId[] = [];
let counter = 0;

interface Fixture {
  orgId: OrgId;
  projectId: string;
  boardId: string;
  listId: string;
  activeStatusId: string;
  doneStatusId: string;
}

async function scaffold(slug: string): Promise<Fixture> {
  counter += 1;
  const orgId = unsafeAsId<'OrgId'>(crypto.randomUUID());
  const projectId = crypto.randomUUID();
  const boardId = crypto.randomUUID();
  const listId = crypto.randomUUID();
  const activeStatusId = crypto.randomUUID();
  const doneStatusId = crypto.randomUUID();

  await admin.setOrg(orgId);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Org ${slug}`,
    `dash-${counter.toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
  ]);
  await admin.query(
    `INSERT INTO work.projects (id, org_id, name, key, next_card_number) VALUES ($1, $2, 'Project', 'PRJ', 1)`,
    [projectId, orgId],
  );
  await admin.query(
    `INSERT INTO work.boards (id, org_id, project_id, name, rank) VALUES ($1, $2, $3, 'Board', 'a0')`,
    [boardId, orgId, projectId],
  );
  await admin.query(
    `INSERT INTO work.lists (id, org_id, project_id, board_id, name, rank) VALUES ($1, $2, $3, $4, 'Backlog', 'a0')`,
    [listId, orgId, projectId, boardId],
  );
  await admin.query(
    `INSERT INTO work.statuses (id, org_id, project_id, name, category, color, position)
     VALUES ($1, $2, $3, 'In progress', 'active', '#3b82f6', 1)`,
    [activeStatusId, orgId, projectId],
  );
  await admin.query(
    `INSERT INTO work.statuses (id, org_id, project_id, name, category, color, position)
     VALUES ($1, $2, $3, 'Done', 'done', '#22c55e', 2)`,
    [doneStatusId, orgId, projectId],
  );
  await admin.setOrg(null);
  created.push(orgId);

  return { orgId, projectId, boardId, listId, activeStatusId, doneStatusId };
}

/** Insert a transition into card_transitions (for burndown tests). */
async function insertTransition(
  f: Fixture,
  cardId: string,
  fromCategory: string | null,
  toCategory: string,
  occurredAt: Date,
): Promise<void> {
  await withOrgScope(f.orgId, async (tx) => {
    await tx.insert(schema.cardTransitions).values({
      id: crypto.randomUUID(),
      orgId: f.orgId,
      cardId,
      boardId: f.boardId,
      projectId: f.projectId,
      fromCategory,
      toCategory,
      occurredAt,
      synthetic: false,
      sourceEventId: crypto.randomUUID(),
    });
  });
}

/** Insert a velocity rollup row. */
async function insertVelocityRollup(
  orgId: OrgId,
  boardId: string,
  day: string,
  doneCount: number,
): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.rollupVelocity).values({
      orgId,
      boardId,
      day,
      doneCount,
    });
  });
}

/** Insert a CFD rollup row. */
async function insertCfdRollup(
  orgId: OrgId,
  boardId: string,
  day: string,
  category: string,
  cardCount: number,
): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.rollupCfd).values({
      orgId,
      boardId,
      day,
      category,
      cardCount,
    });
  });
}

/** Insert a cycle time rollup row. */
async function insertCycleTimeRollup(
  orgId: OrgId,
  cardId: string,
  boardId: string,
  projectId: string,
  cycleTimeHours: number | null,
): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.rollupCycleTime).values({
      orgId,
      cardId,
      boardId,
      projectId,
      cycleTimeHours,
    });
  });
}

/** Insert a volume rollup row. */
async function insertVolumeRollup(
  orgId: OrgId,
  day: string,
  data: { messageCount?: number; callCount?: number; callDurationMin?: number; inAppCallCount?: number },
): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.rollupVolume).values({
      orgId,
      day,
      messageCount: data.messageCount ?? 0,
      callCount: data.callCount ?? 0,
      callDurationMin: data.callDurationMin ?? 0,
      inAppCallCount: data.inAppCallCount ?? 0,
    });
  });
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(12, 0, 0, 0);
  return d;
}


function dayStr(n: number): string {
  return daysAgo(n).toISOString().slice(0, 10);
}

async function removeOrg(orgId: OrgId): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM analytics.card_transitions WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM analytics.rollup_velocity WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM analytics.rollup_cfd WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM analytics.rollup_cycle_time WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM analytics.rollup_volume WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM analytics.rollup_burndown WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.statuses WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();
  initializeDatabase({ url: APP_URL, applicationName: 'taskflow-analytics-dashboard-test' });
  initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-analytics-dashboard-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
  await admin.setOrg(null);
  await admin.end();
});

describe('queryVelocity', () => {
  it('counts done transitions per day from rollup', async () => {
    const f = await scaffold('velocity');
    const today = dayStr(0);
    const yesterday = dayStr(1);

    await insertVelocityRollup(f.orgId, f.boardId, yesterday, 1);
    await insertVelocityRollup(f.orgId, f.boardId, today, 1);

    const points = await queryVelocity(f.orgId, {
      startDate: daysAgo(7),
      endDate: daysAgo(0),
    });

    const yesterdayPt = points.find((p) => p.date === yesterday);
    const todayPt = points.find((p) => p.date === today);
    expect(yesterdayPt?.count).toBe(1);
    expect(todayPt?.count).toBe(1);
  });

  it('returns empty for a date range with no rollup data', async () => {
    const f = await scaffold('velocity-empty');
    const points = await queryVelocity(f.orgId, {
      startDate: daysAgo(7),
      endDate: daysAgo(1),
    });
    expect(points).toHaveLength(0);
  });

  it('aggregates across boards when no boardId specified', async () => {
    const f = await scaffold('velocity-multi');
    const boardB = crypto.randomUUID();
    await admin.setOrg(f.orgId);
    await admin.query(
      `INSERT INTO work.boards (id, org_id, project_id, name, rank) VALUES ($1, $2, $3, 'Board B', 'a1')`,
      [boardB, f.orgId, f.projectId],
    );
    await admin.setOrg(null);

    const yesterday = dayStr(1);
    await insertVelocityRollup(f.orgId, f.boardId, yesterday, 2);
    await insertVelocityRollup(f.orgId, boardB, yesterday, 3);

    const points = await queryVelocity(f.orgId, {
      startDate: daysAgo(7),
      endDate: daysAgo(0),
    });

    const pt = points.find((p) => p.date === yesterday);
    expect(pt?.count).toBe(5); // 2 + 3 across boards
  });
});

describe('queryBurndown', () => {
  it('computes remaining cards from rollup_burndown (date-range mode)', async () => {
    const f = await scaffold('burndown');
    const cardA = crypto.randomUUID();
    const cardB = crypto.randomUUID();
    const cardC = crypto.randomUUID();
    const start = daysAgo(5);
    const end = daysAgo(0);

    // All 3 cards enter the project before the window (for totalCards count).
    await insertTransition(f, cardA, null, 'not_started', daysAgo(10));
    await insertTransition(f, cardB, null, 'not_started', daysAgo(10));
    await insertTransition(f, cardC, null, 'not_started', daysAgo(10));

    // Populate rollup_burndown: card A done on day 4, card B done on day 2.
    await withOrgScope(f.orgId, async (tx) => {
      await tx.insert(schema.rollupBurndown).values({
        orgId: f.orgId, projectId: f.projectId, day: dayStr(4), doneCount: 1, undoneCount: 0,
      });
      await tx.insert(schema.rollupBurndown).values({
        orgId: f.orgId, projectId: f.projectId, day: dayStr(2), doneCount: 1, undoneCount: 0,
      });
    });

    const points = await queryBurndown(f.orgId, {
      projectId: f.projectId,
      startDate: start,
      endDate: end,
    });

    // At start: 3 distinct cards total, 0 done → remaining = 3.
    expect(points[0]?.remaining).toBe(3);

    // After day 4 (card A done): remaining = 2.
    const day4 = points.find((p) => p.date === dayStr(4));
    expect(day4?.remaining).toBe(2);

    // After day 2 (card B done): remaining = 1.
    const day2 = points.find((p) => p.date === dayStr(2));
    expect(day2?.remaining).toBe(1);

    // At end: 1 remaining (card C).
    expect(points[points.length - 1]?.remaining).toBe(1);
  });
});

describe('queryCfd', () => {
  it('tracks category counts from rollup', async () => {
    const f = await scaffold('cfd');
    const start = daysAgo(5);
    const end = daysAgo(0);

    // At start: 2 not_started.
    await insertCfdRollup(f.orgId, f.boardId, dayStr(5), 'not_started', 2);
    await insertCfdRollup(f.orgId, f.boardId, dayStr(5), 'active', 0);
    await insertCfdRollup(f.orgId, f.boardId, dayStr(5), 'done', 0);

    // Day 4: 1 not_started, 1 active.
    await insertCfdRollup(f.orgId, f.boardId, dayStr(4), 'not_started', 1);
    await insertCfdRollup(f.orgId, f.boardId, dayStr(4), 'active', 1);
    await insertCfdRollup(f.orgId, f.boardId, dayStr(4), 'done', 0);

    // Day 2: 0 not_started, 1 active, 1 done.
    await insertCfdRollup(f.orgId, f.boardId, dayStr(2), 'not_started', 0);
    await insertCfdRollup(f.orgId, f.boardId, dayStr(2), 'active', 1);
    await insertCfdRollup(f.orgId, f.boardId, dayStr(2), 'done', 1);

    const points = await queryCfd(f.orgId, {
      boardId: f.boardId,
      startDate: start,
      endDate: end,
    });

    // At start: carry-forward from day 5 rollup.
    expect(points[0]?.notStarted).toBe(2);
    expect(points[0]?.active).toBe(0);
    expect(points[0]?.done).toBe(0);

    // Day 4: from rollup.
    const day4 = points.find((p) => p.date === dayStr(4));
    expect(day4?.notStarted).toBe(1);
    expect(day4?.active).toBe(1);
    expect(day4?.done).toBe(0);

    // Day 3: no rollup → carry-forward from day 4.
    const day3 = points.find((p) => p.date === dayStr(3));
    expect(day3?.notStarted).toBe(1);
    expect(day3?.active).toBe(1);
    expect(day3?.done).toBe(0);

    // Day 2: from rollup.
    const day2 = points.find((p) => p.date === dayStr(2));
    expect(day2?.notStarted).toBe(0);
    expect(day2?.active).toBe(1);
    expect(day2?.done).toBe(1);
  });
});

describe('queryCycleTime', () => {
  it('computes median and p85 from rollup', async () => {
    const f = await scaffold('cycle-time');

    // Card A: 24h cycle.
    await insertCycleTimeRollup(f.orgId, crypto.randomUUID(), f.boardId, f.projectId, 24);
    // Card B: 48h cycle.
    await insertCycleTimeRollup(f.orgId, crypto.randomUUID(), f.boardId, f.projectId, 48);
    // Card C: open (null cycle time).
    await insertCycleTimeRollup(f.orgId, crypto.randomUUID(), f.boardId, f.projectId, null);

    const result = await queryCycleTime(f.orgId, {
      projectId: f.projectId,
    });

    expect(result.count).toBe(2); // only A and B
    expect(result.openCount).toBe(1); // card C
    expect(result.medianHours).toBe(24); // lower median of [24, 48]
    expect(result.p85Hours).toBe(48); // p85 of [24, 48]
  });
});

describe('queryWorkload', () => {
  it('counts open cards per assignee', async () => {
    const f = await scaffold('workload');
    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();

    // Create cards with assignees directly in the DB.
    await admin.setOrg(f.orgId);
    await admin.query(
      `INSERT INTO work.cards (id, org_id, project_id, board_id, list_id, number, title, description, description_text, rank, assignee_ids)
       VALUES ($1, $2, $3, $4, $5, 1, 'Card A', '{}'::jsonb, '', 'a0', $6)`,
      [crypto.randomUUID(), f.orgId, f.projectId, f.boardId, f.listId, [userA]],
    );
    await admin.query(
      `INSERT INTO work.cards (id, org_id, project_id, board_id, list_id, number, title, description, description_text, rank, assignee_ids)
       VALUES ($1, $2, $3, $4, $5, 2, 'Card B', '{}'::jsonb, '', 'a0', $6)`,
      [crypto.randomUUID(), f.orgId, f.projectId, f.boardId, f.listId, [userA, userB]],
    );
    await admin.query(
      `INSERT INTO work.cards (id, org_id, project_id, board_id, list_id, number, title, description, description_text, rank, assignee_ids)
       VALUES ($1, $2, $3, $4, $5, 3, 'Card C', '{}'::jsonb, '', 'a0', $6)`,
      [crypto.randomUUID(), f.orgId, f.projectId, f.boardId, f.listId, [userB]],
    );
    await admin.setOrg(null);

    const entries = await queryWorkload(f.orgId, {});

    // userA: 2 cards, userB: 2 cards.
    expect(entries).toHaveLength(2);
    const userAEntry = entries.find((e) => e.userId === userA);
    const userBEntry = entries.find((e) => e.userId === userB);
    expect(userAEntry?.cardCount).toBe(2);
    expect(userBEntry?.cardCount).toBe(2);
  });
});

describe('queryVolume', () => {
  it('returns volume data from rollup', async () => {
    const f = await scaffold('volume');
    const yesterday = dayStr(1);

    await insertVolumeRollup(f.orgId, yesterday, {
      messageCount: 10,
      callCount: 3,
      callDurationMin: 15.5,
      inAppCallCount: 2,
    });

    const points = await queryVolume(f.orgId, {
      startDate: daysAgo(7),
      endDate: daysAgo(0),
    });

    const pt = points.find((p) => p.date === yesterday);
    expect(pt?.messages).toBe(10);
    expect(pt?.calls).toBe(3);
    expect(pt?.callDurationMinutes).toBe(15.5);
    expect(pt?.inAppCalls).toBe(2);
  });

  it('zero-fills days with no rollup data', async () => {
    const f = await scaffold('volume-sparse');
    const today = dayStr(0);

    // Only insert for today.
    await insertVolumeRollup(f.orgId, today, { messageCount: 5 });

    const points = await queryVolume(f.orgId, {
      startDate: daysAgo(3),
      endDate: daysAgo(0),
    });

    expect(points).toHaveLength(4); // 4 days in range
    const todayPt = points.find((p) => p.date === today);
    expect(todayPt?.messages).toBe(5);
    const yesterdayPt = points.find((p) => p.date === dayStr(1));
    expect(yesterdayPt?.messages).toBe(0); // zero-filled
  });
});
