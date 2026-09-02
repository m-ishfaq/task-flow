import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import {
  closeDatabase,
  eq,
  initializeAuditDatabase,
  initializeDatabase,
  schema,
  withOrgScope,
  type OutboxRow,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { drainAnalyticsFully, indexCardTransition } from './projection.relay.js';

/**
 * The analytics transitions projection (Phase 11 Wave 1, migration 0091),
 * against real Postgres and the real `taskflow_audit` claim role — not a stub.
 *
 * The claim step reuses taskflow_audit under consumer = 'analytics', and the
 * three `outbox_dispatch` policies 0091 adds for it are exactly the kind of
 * grant that looks correct in a migration and silently claims (or marks)
 * nothing if wrong — the standing lesson of migrations 0016, 0089 and every
 * consumer relay since. Only a real connection as the real role proves it.
 */

const APP_URL = 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test';
const AUDIT_URL = 'postgresql://taskflow_audit:audit-dev-secret@localhost:5433/taskflow_test';

let admin: AdminConnection;
let created: OrgId[] = [];
let counter = 0;

interface Fixture {
  readonly orgId: OrgId;
  readonly projectId: string;
  readonly boardId: string;
  readonly cardId: string;
  readonly activeStatusId: string;
  readonly doneStatusId: string;
  /** Enqueues a `card.status_changed` outbox row and returns its event id. */
  readonly emit: (payload: Record<string, unknown>) => Promise<string>;
}

async function scaffold(slug: string): Promise<Fixture> {
  counter += 1;
  const orgId = unsafeAsId<'OrgId'>(crypto.randomUUID());
  const projectId = crypto.randomUUID();
  const boardId = crypto.randomUUID();
  const listId = crypto.randomUUID();
  const cardId = crypto.randomUUID();
  const activeStatusId = crypto.randomUUID();
  const doneStatusId = crypto.randomUUID();

  await admin.setOrg(orgId);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Org ${slug}`,
    `an-${counter.toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
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
  await admin.query(
    `INSERT INTO work.cards (id, org_id, project_id, board_id, list_id, number, title, description, description_text, rank)
     VALUES ($1, $2, $3, $4, $5, 1, 'Ship it', '{}'::jsonb, '', 'a0')`,
    [cardId, orgId, projectId, boardId, listId],
  );
  await admin.setOrg(null);
  created.push(orgId);

  return {
    orgId,
    projectId,
    boardId,
    cardId,
    activeStatusId,
    doneStatusId,
    emit: async (payload) => {
      const eventId = crypto.randomUUID();
      await admin.setOrg(orgId);
      await admin.query(
        `INSERT INTO platform.outbox (id, org_id, name, version, occurred_at, payload)
         VALUES ($1, $2, 'card.status_changed', 1, now(), $3::jsonb)`,
        [eventId, orgId, JSON.stringify(payload)],
      );
      await admin.setOrg(null);
      return eventId;
    },
  };
}

interface TransitionRow {
  cardId: string;
  boardId: string;
  projectId: string;
  fromCategory: string | null;
  toCategory: string;
  synthetic: boolean;
  sourceEventId: string | null;
}

async function transitionRows(orgId: OrgId): Promise<TransitionRow[]> {
  return withOrgScope(orgId, async (tx) =>
    tx
      .select({
        cardId: schema.cardTransitions.cardId,
        boardId: schema.cardTransitions.boardId,
        projectId: schema.cardTransitions.projectId,
        fromCategory: schema.cardTransitions.fromCategory,
        toCategory: schema.cardTransitions.toCategory,
        synthetic: schema.cardTransitions.synthetic,
        sourceEventId: schema.cardTransitions.sourceEventId,
      })
      .from(schema.cardTransitions)
      .where(eq(schema.cardTransitions.orgId, orgId)),
  );
}

/** An outbox row shaped like the relay produces, for the idempotency test that drives `indexCardTransition` directly. */
function outboxRow(
  orgId: OrgId,
  payload: Record<string, unknown>,
  id = crypto.randomUUID(),
): OutboxRow {
  return {
    id,
    orgId,
    name: 'card.status_changed',
    version: 1,
    actorId: null,
    occurredAt: new Date(),
    requestId: null,
    causationDepth: 0,
    payload,
    attempts: 0,
  };
}

async function removeOrg(orgId: OrgId): Promise<void> {
  await admin.setOrg(orgId);
  // Children before parents; dispatch rows reference outbox rows, so first.
  await admin.query(
    `DELETE FROM platform.outbox_dispatch WHERE event_id IN
     (SELECT id FROM platform.outbox WHERE org_id = $1)`,
    [orgId],
  );
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
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
  initializeDatabase({ url: APP_URL, applicationName: 'taskflow-analytics-relay-test' });
  initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-analytics-relay-test' });
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

describe('analytics transitions projection', () => {
  it('claims a card.status_changed as taskflow_audit and writes a row with the category frozen', async () => {
    const f = await scaffold('active-to-done');
    await f.emit({
      cardId: f.cardId,
      boardId: f.boardId,
      before: f.activeStatusId,
      after: f.doneStatusId,
    });

    // `drainAnalytics` claims for consumer 'analytics' across the GLOBAL
    // outbox, so a sibling suite running in parallel against this shared
    // taskflow_test can leave its own card.status_changed events pending for
    // this consumer — they are claimed here too. So the drain's own counts are
    // "at least ours", never exactly one (the `ours()` lesson in relay.test.ts
    // and audit.test.ts). Drain FULLY, not one batch: a large parallel backlog
    // could otherwise push this org's event past a single 100-row claim and
    // leave the scoped assertion below with zero rows. The correctness proof is
    // that org-SCOPED row count: this org is a fresh random id nothing else
    // touches.
    const result = await drainAnalyticsFully();
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(result.written).toBeGreaterThanOrEqual(1);

    const rows = await transitionRows(f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cardId: f.cardId,
      boardId: f.boardId,
      projectId: f.projectId,
      fromCategory: 'active',
      toCategory: 'done',
      synthetic: false,
    });
    // Real (non-synthetic) rows carry their source event id for idempotency.
    expect(rows[0]?.sourceEventId).not.toBeNull();
  });

  it("resolves a null 'before' status to not_started rather than leaving it blank", async () => {
    const f = await scaffold('no-status-first');
    await f.emit({ cardId: f.cardId, boardId: f.boardId, before: null, after: f.activeStatusId });

    await drainAnalyticsFully();

    const rows = await transitionRows(f.orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fromCategory).toBe('not_started');
    expect(rows[0]?.toCategory).toBe('active');
  });

  it('is idempotent — the same event re-processed inserts nothing', async () => {
    const f = await scaffold('idempotent');
    const row = outboxRow(f.orgId, {
      cardId: f.cardId,
      boardId: f.boardId,
      before: f.activeStatusId,
      after: f.doneStatusId,
    });

    // Simulates the crash window: a claimed event written but not marked, then
    // re-claimed and re-processed on the next tick. ON CONFLICT DO NOTHING is
    // the whole defence.
    await indexCardTransition(f.orgId, row);
    await indexCardTransition(f.orgId, row);

    const rows = await transitionRows(f.orgId);
    expect(rows).toHaveLength(1);
  });
});
