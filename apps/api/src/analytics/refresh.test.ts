import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import {
  closeDatabase,
  eq,
  initializeAuditDatabase,
  initializeDatabase,
  schema,
  withOrgScope,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { refreshOrg } from './refresh.js';

/**
 * Integration test for the analytics refresh service (Phase 11).
 *
 * Proves the rollup computation SQL is correct against real Postgres:
 * - Inserts card_transitions with known transitions
 * - Runs refreshOrg to populate rollup tables
 * - Verifies velocity, CFD, cycle time, and volume rollups match expected values
 *
 * Calls `refreshOrg` directly rather than `refreshAllOrgs`, because the
 * latter iterates via `listOrgIds()` which uses `withGlobalScope` — and
 * the RLS policy on `identity.orgs` returns zero rows when `app.org_id`
 * is unset (the `orgs_tenant_isolation` USING clause evaluates to
 * UNKNOWN). Tests bypass the org-discovery step by calling the per-org
 * function directly.
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
}

async function scaffold(slug: string): Promise<Fixture> {
  counter += 1;
  const orgId = unsafeAsId<'OrgId'>(crypto.randomUUID());
  const projectId = crypto.randomUUID();
  const boardId = crypto.randomUUID();
  const listId = crypto.randomUUID();

  await admin.setOrg(orgId);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Org ${slug}`,
    `refresh-${counter.toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
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
  await admin.setOrg(null);
  created.push(orgId);

  return { orgId, projectId, boardId, listId };
}

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
  await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();
  initializeDatabase({ url: APP_URL, applicationName: 'taskflow-analytics-refresh-test' });
  initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-analytics-refresh-test' });
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

describe('refreshOrg — velocity rollup', () => {
  it('computes done transitions per board per day', async () => {
    const f = await scaffold('refresh-velocity');
    const cardA = crypto.randomUUID();
    const cardB = crypto.randomUUID();

    // Card A: done yesterday.
    await insertTransition(f, cardA, 'active', 'done', daysAgo(1));
    // Card B: done today.
    await insertTransition(f, cardB, 'active', 'done', daysAgo(0));

    // Run refresh for this org directly.
    const result = await refreshOrg(f.orgId);

    expect(result.velocityRows).toBe(2);

    // Check rollup rows.
    await withOrgScope(f.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.rollupVelocity)
        .where(eq(schema.rollupVelocity.orgId, f.orgId))
        .orderBy(schema.rollupVelocity.day);

      expect(rows.length).toBe(2);

      const yesterdayRow = rows.find((r) => r.day === dayStr(1));
      const todayRow = rows.find((r) => r.day === dayStr(0));

      expect(yesterdayRow?.doneCount).toBe(1);
      expect(todayRow?.doneCount).toBe(1);
    });
  });
});

describe('refreshOrg — CFD rollup', () => {
  it('computes category counts per board per day', async () => {
    const f = await scaffold('refresh-cfd');
    const cardA = crypto.randomUUID();
    const cardB = crypto.randomUUID();

    // Both cards start in not_started.
    await insertTransition(f, cardA, null, 'not_started', daysAgo(5));
    await insertTransition(f, cardB, null, 'not_started', daysAgo(5));

    // Card A moves to active yesterday.
    await insertTransition(f, cardA, 'not_started', 'active', daysAgo(1));

    // Card A moves to done today, card B moves to active today.
    await insertTransition(f, cardA, 'active', 'done', daysAgo(0));
    await insertTransition(f, cardB, 'not_started', 'active', daysAgo(0));

    const result = await refreshOrg(f.orgId);

    expect(result.cfdRows).toBeGreaterThan(0);

    await withOrgScope(f.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.rollupCfd)
        .where(eq(schema.rollupCfd.orgId, f.orgId))
        .orderBy(schema.rollupCfd.day);

      // Find the last day's CFD state.
      const lastDay = rows.filter((r) => r.day === dayStr(0));
      const notStarted = lastDay.find((r) => r.category === 'not_started');
      const active = lastDay.find((r) => r.category === 'active');
      const done = lastDay.find((r) => r.category === 'done');

      // At end of today: 0 not_started, 1 active (cardB), 1 done (cardA).
      expect(notStarted?.cardCount).toBe(0);
      expect(active?.cardCount).toBe(1);
      expect(done?.cardCount).toBe(1);
    });
  });
});

describe('refreshOrg — cycle time rollup', () => {
  it('computes per-card cycle time from active to done', async () => {
    const f = await scaffold('refresh-cycle');
    const cardA = crypto.randomUUID();
    const cardB = crypto.randomUUID();

    // Card A: active 48h ago, done 24h ago → 24h cycle.
    await insertTransition(f, cardA, null, 'active', daysAgo(2));
    await insertTransition(f, cardA, 'active', 'done', daysAgo(1));

    // Card B: active 24h ago, never done → open.
    await insertTransition(f, cardB, null, 'active', daysAgo(1));

    const result = await refreshOrg(f.orgId);

    expect(result.cycleTimeRows).toBe(2);

    await withOrgScope(f.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.rollupCycleTime)
        .where(eq(schema.rollupCycleTime.orgId, f.orgId));

      expect(rows.length).toBe(2);

      const cardARow = rows.find((r) => r.cardId === cardA);
      const cardBRow = rows.find((r) => r.cardId === cardB);

      // Card A: ~24h cycle.
      expect(cardARow?.cycleTimeHours).toBeCloseTo(24, 0);
      expect(cardARow?.firstDoneAt).not.toBeNull();

      // Card B: open (null cycle time).
      expect(cardBRow?.cycleTimeHours).toBeNull();
    });
  });
});

describe('refreshOrg — idempotency', () => {
  it('running refresh twice produces the same result', async () => {
    const f = await scaffold('refresh-idempotent');
    const cardA = crypto.randomUUID();
    await insertTransition(f, cardA, 'active', 'done', daysAgo(1));

    await refreshOrg(f.orgId);
    await refreshOrg(f.orgId); // second run

    await withOrgScope(f.orgId, async (tx) => {
      const velocityRows = await tx
        .select()
        .from(schema.rollupVelocity)
        .where(eq(schema.rollupVelocity.orgId, f.orgId));

      // Should have exactly 1 row per (board, day), not duplicated.
      const yesterdayRows = velocityRows.filter((r) => r.day === dayStr(1));
      expect(yesterdayRows.length).toBe(1);
      expect(yesterdayRows[0]?.doneCount).toBe(1);
    });
  });
});

describe('refreshOrg — volume rollup', () => {
  it('computes daily message and call counts', async () => {
    const f = await scaffold('refresh-volume');

    // Insert a message and check the volume rollup picks it up.
    const channelA = crypto.randomUUID();
    await admin.setOrg(f.orgId);
    await admin.query(
      `INSERT INTO chat.channels (id, org_id, name, type, created_by) VALUES ($1, $2, 'general', 'public', NULL)`,
      [channelA, f.orgId],
    );
    await admin.query(
      `INSERT INTO chat.messages (id, org_id, channel_id, author_id, body, body_text) VALUES ($1, $2, $3, NULL, '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hello"}]}]}'::jsonb, 'hello')`,
      [crypto.randomUUID(), f.orgId, channelA],
    );
    await admin.setOrg(null);

    const result = await refreshOrg(f.orgId);

    expect(result.volumeRows).toBeGreaterThanOrEqual(1);

    await withOrgScope(f.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.rollupVolume)
        .where(eq(schema.rollupVolume.orgId, f.orgId));

      expect(rows.length).toBeGreaterThanOrEqual(1);

      // At least one day should have message_count > 0.
      const hasMessages = rows.some((r) => r.messageCount > 0);
      expect(hasMessages).toBe(true);
    });
  });
});

describe('refreshOrg — burndown rollup', () => {
  it('computes done/undone per project per day', async () => {
    const f = await scaffold('refresh-burndown');
    const cardA = crypto.randomUUID();
    const cardB = crypto.randomUUID();

    // Card A: done yesterday.
    await insertTransition(f, cardA, 'active', 'done', daysAgo(1));
    // Card B: done yesterday too.
    await insertTransition(f, cardB, 'active', 'done', daysAgo(1));

    const result = await refreshOrg(f.orgId);

    expect(result.burndownRows).toBeGreaterThanOrEqual(1);

    await withOrgScope(f.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.rollupBurndown)
        .where(eq(schema.rollupBurndown.orgId, f.orgId));

      expect(rows.length).toBe(1); // one day

      const row = rows[0];
      expect(row?.doneCount).toBe(2); // 2 cards done yesterday
      expect(row?.undoneCount).toBe(0); // no undone
    });
  });
});
