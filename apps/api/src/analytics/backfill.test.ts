import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import {
  closeDatabase,
  eq,
  countRows,
  initializeAuditDatabase,
  initializeDatabase,
  schema,
  withOrgScope,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { backfillSyntheticCreationRows } from './backfill.js';

/**
 * The analytics backfill (Phase 11 Wave 2, ai/phase-11-analytics.md §2.2),
 * against real Postgres and the real schema.
 *
 * Tests that cards with no transition row receive a synthetic creation row,
 * and that re-running is idempotent.
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
    `bf-${counter.toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
  ]);
  await admin.query(
    `INSERT INTO work.projects (id, org_id, name, key, next_card_number) VALUES ($1, $2, 'Project', 'PROJ', 1)`,
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

async function createCard(
  f: Fixture,
  opts?: { statusId?: string; createdAt?: Date },
): Promise<string> {
  const cardId = crypto.randomUUID();
  await admin.setOrg(f.orgId);
  await admin.query(
    `INSERT INTO work.cards (id, org_id, project_id, board_id, list_id, number, title, description, description_text, rank, status_id, created_at)
     VALUES ($1, $2, $3, $4, $5, 1, 'Test Card', '{}'::jsonb, '', 'a0', $6, $7)`,
    [
      cardId,
      f.orgId,
      f.projectId,
      f.boardId,
      f.listId,
      opts?.statusId ?? f.activeStatusId,
      opts?.createdAt ?? new Date(),
    ],
  );
  await admin.setOrg(null);
  return cardId;
}

async function transitionCount(orgId: OrgId): Promise<number> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ count: countRows(schema.cardTransitions.id).as('count') })
      .from(schema.cardTransitions)
      .where(eq(schema.cardTransitions.orgId, orgId));
    return Number(rows[0]?.count ?? 0);
  });
}

async function removeOrg(orgId: OrgId): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM analytics.card_transitions WHERE org_id = $1`, [orgId]);
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
  initializeDatabase({ url: APP_URL, applicationName: 'taskflow-analytics-backfill-test' });
  initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-analytics-backfill-test' });
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

describe('analytics backfill', () => {
  it('creates synthetic creation rows for cards with no transitions', async () => {
    const f = await scaffold('no-transitions');
    const cardId = await createCard(f);

    const result = await backfillSyntheticCreationRows(f.orgId);
    expect(result).toBe(1);

    // Verify the transition row was created.
    const count = await transitionCount(f.orgId);
    expect(count).toBe(1);

    // Verify it is synthetic with correct category.
    await withOrgScope(f.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.cardTransitions)
        .where(eq(schema.cardTransitions.orgId, f.orgId));
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.synthetic).toBe(true);
      expect(row?.fromCategory).toBeNull();
      expect(row?.toCategory).toBe('active');
      expect(row?.sourceEventId).toBeNull();
      expect(row?.cardId).toBe(cardId);
    });
  });

  it('resolves status category from work.statuses at backfill time', async () => {
    const f = await scaffold('done-status');
    await createCard(f, { statusId: f.doneStatusId });

    const result = await backfillSyntheticCreationRows(f.orgId);
    expect(result).toBe(1);

    await withOrgScope(f.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.cardTransitions)
        .where(eq(schema.cardTransitions.orgId, f.orgId));
      expect(rows[0]?.toCategory).toBe('done');
    });
  });

  it('treats null status as not_started', async () => {
    const f = await scaffold('null-status');
    const cardId = crypto.randomUUID();
    await admin.setOrg(f.orgId);
    await admin.query(
      `INSERT INTO work.cards (id, org_id, project_id, board_id, list_id, number, title, description, description_text, rank)
       VALUES ($1, $2, $3, $4, $5, 1, 'No Status', '{}'::jsonb, '', 'a0')`,
      [cardId, f.orgId, f.projectId, f.boardId, f.listId],
    );
    await admin.setOrg(null);

    await backfillSyntheticCreationRows(f.orgId);

    await withOrgScope(f.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.cardTransitions)
        .where(eq(schema.cardTransitions.orgId, f.orgId));
      expect(rows[0]?.toCategory).toBe('not_started');
    });
  });

  it('is idempotent — re-running creates no duplicates', async () => {
    const f = await scaffold('idempotent');
    await createCard(f);

    await backfillSyntheticCreationRows(f.orgId);
    const secondResult = await backfillSyntheticCreationRows(f.orgId);

    // Second run should produce 0 new rows (ON CONFLICT DO NOTHING).
    expect(secondResult).toBe(0);
    const count = await transitionCount(f.orgId);
    expect(count).toBe(1);
  });

  it('skips cards that already have a transition row', async () => {
    const f = await scaffold('already-has-transition');
    const cardId = await createCard(f);

    // Manually insert a transition row for this card.
    await withOrgScope(f.orgId, async (tx) => {
      await tx.insert(schema.cardTransitions).values({
        id: crypto.randomUUID(),
        orgId: f.orgId,
        cardId,
        boardId: f.boardId,
        projectId: f.projectId,
        fromCategory: null,
        toCategory: 'active',
        occurredAt: new Date(),
        synthetic: false,
        sourceEventId: crypto.randomUUID(),
      });
    });

    const result = await backfillSyntheticCreationRows(f.orgId);
    expect(result).toBe(0);

    const count = await transitionCount(f.orgId);
    expect(count).toBe(1);
  });
});
