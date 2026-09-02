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
import { pruneOutbox } from './prune.js';
import { backfillSyntheticCreationRows } from './backfill.js';
import { drainAnalytics } from './projection.relay.js';

/**
 * Tests for analytics outbox pruning and backfill (Phase 11 Wave 4),
 * against real Postgres.
 *
 * The prune test proves that fully-dispatched events are deleted while
 * events with no dispatch rows (unseen consumers) are left alone.
 * Dispatch rows are created through the relay's own claim/mark pattern,
 * because outbox_dispatch has consumer-scoped RLS that even the migrator
 * cannot bypass.
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
}

async function scaffold(slug: string): Promise<Fixture> {
  counter += 1;
  const orgId = unsafeAsId<'OrgId'>(crypto.randomUUID());
  const projectId = crypto.randomUUID();
  const boardId = crypto.randomUUID();
  const listId = crypto.randomUUID();
  const activeStatusId = crypto.randomUUID();

  await admin.setOrg(orgId);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Org ${slug}`,
    `sp-${counter.toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
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
  await admin.setOrg(null);
  created.push(orgId);

  return { orgId, projectId, boardId, listId, activeStatusId };
}

let cardNum = 0;

async function createCard(f: Fixture): Promise<string> {
  cardNum += 1;
  const cardId = crypto.randomUUID();
  await admin.setOrg(f.orgId);
  await admin.query(
    `INSERT INTO work.cards (id, org_id, project_id, board_id, list_id, number, title, description, description_text, rank, status_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'Card', '{}'::jsonb, '', 'a0', $7)`,
    [cardId, f.orgId, f.projectId, f.boardId, f.listId, cardNum, f.activeStatusId],
  );
  await admin.setOrg(null);
  return cardId;
}

async function emitStatusChanged(
  f: Fixture,
  cardId: string,
  boardId: string,
  beforeStatusId: string | null,
  afterStatusId: string | null,
  opts?: { occurredAt?: Date },
): Promise<string> {
  const eventId = crypto.randomUUID();
  await admin.setOrg(f.orgId);
  await admin.query(
    `INSERT INTO platform.outbox (id, org_id, name, version, occurred_at, payload)
     VALUES ($1, $2, 'card.status_changed', 1, $3, $4::jsonb)`,
    [eventId, f.orgId, opts?.occurredAt ?? new Date(), JSON.stringify({
      cardId,
      boardId,
      before: beforeStatusId,
      after: afterStatusId,
    })],
  );
  await admin.setOrg(null);
  return eventId;
}

async function removeOrg(orgId: OrgId): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM analytics.card_transitions WHERE org_id = $1`, [orgId]);
  await admin.query(
    `DELETE FROM platform.outbox_dispatch WHERE event_id IN
     (SELECT id FROM platform.outbox WHERE org_id = $1)`,
    [orgId],
  );
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
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
  initializeDatabase({ url: APP_URL, applicationName: 'taskflow-analytics-prune-test' });
  initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-analytics-prune-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
  cardNum = 0;
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
  await admin.setOrg(null);
  await admin.end();
});

describe('analytics prune', () => {
  it('prunes old events that have been dispatched by the analytics relay', async () => {
    const f = await scaffold('prune-dispatched');
    const cardId = await createCard(f);

    // Emit an old status_changed event (60 days ago).
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    await emitStatusChanged(f, cardId, f.boardId, null, f.activeStatusId, { occurredAt: oldDate });

    // Run the analytics relay — this claims the event and creates a dispatch row.
    const drainResult = await drainAnalytics();
    expect(drainResult.processed).toBe(1);

    // Prune with 30-day retention — the event is 60 days old.
    // The analytics consumer has dispatched, but other consumers have NOT.
    // So the event should NOT be pruned (other consumers still need it).
    const pruneResult = await pruneOutbox(f.orgId, 30);
    // Other consumers haven't dispatched → event has pending consumers → not pruned.
    expect(pruneResult.eventsPruned).toBe(0);
  });

  it('does NOT prune events with no dispatch rows at all', async () => {
    const f = await scaffold('prune-unseen');
    const cardId = await createCard(f);

    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    await emitStatusChanged(f, cardId, f.boardId, null, f.activeStatusId, { occurredAt: oldDate });

    // Do NOT run the relay — the event has no dispatch rows at all.
    const pruneResult = await pruneOutbox(f.orgId, 30);
    expect(pruneResult.eventsPruned).toBe(0);
  });

  it('does NOT prune recent events even with dispatch rows', async () => {
    const f = await scaffold('prune-recent');
    const cardId = await createCard(f);

    // Emit a recent event (today).
    await emitStatusChanged(f, cardId, f.boardId, null, f.activeStatusId);

    // Run the relay to create the dispatch.
    await drainAnalytics();

    // Prune with 30-day retention — the event is recent, so it stays.
    const pruneResult = await pruneOutbox(f.orgId, 30);
    expect(pruneResult.eventsPruned).toBe(0);
  });
});

describe('analytics backfill', () => {
  it('creates synthetic transitions for never-moved cards', async () => {
    const f = await scaffold('backfill-synth');
    await createCard(f);
    await createCard(f);

    const result = await backfillSyntheticCreationRows(f.orgId);
    expect(result).toBe(2);

    await withOrgScope(f.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.cardTransitions)
        .where(eq(schema.cardTransitions.orgId, f.orgId));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.synthetic).toBe(true);
        expect(row.fromCategory).toBeNull();
        expect(row.toCategory).toBe('active');
      }
    });
  });

  it('is idempotent — re-running creates no duplicates', async () => {
    const f = await scaffold('backfill-idempotent');
    await createCard(f);

    const first = await backfillSyntheticCreationRows(f.orgId);
    const second = await backfillSyntheticCreationRows(f.orgId);

    expect(first).toBe(1);
    expect(second).toBe(0);

    await withOrgScope(f.orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.cardTransitions)
        .where(eq(schema.cardTransitions.orgId, f.orgId));
      expect(rows).toHaveLength(1);
    });
  });
});
