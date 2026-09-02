import {
  claimPending,
  eq,
  markDispatched,
  schema,
  withAuditScope,
  withOrgScope,
  type OutboxRow,
} from '@taskflow/db';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { newId } from '@taskflow/security';
import type { Logger } from '@taskflow/observability';
import { cardStatusChanged } from '../work/events.js';

/**
 * The analytics transitions projection relay (Phase 11 Wave 1,
 * ai/phase-11-analytics.md §1-§2, migration 0091's own header).
 *
 * The fifth outbox consumer on the search.documents pattern, with one
 * deliberate difference migration 0091's header explains: it CLAIMS under
 * taskflow_audit (consumer = 'analytics'), not a dedicated role — the same
 * choice call-wake made (0089), because a low-volume status-change consumer
 * does not justify its own role and connection.
 *
 *  1. CLAIM, cross-tenant, as taskflow_audit — `claimPending(tx, 'analytics')`.
 *  2. WORK, per event, under withOrgScope(orgId) as taskflow_app — resolve the
 *     board's project and the from/to status CATEGORY, then append a fact row.
 *     taskflow_audit holds nothing on analytics.card_transitions on purpose.
 *  3. MARK, in the same claim transaction — `markDispatched`.
 *
 * At-least-once by the claim contract; idempotent by `ON CONFLICT DO NOTHING`
 * against the migration's `(org_id, source_event_id)` partial-unique — a
 * redelivered event inserts nothing.
 *
 * ## Category is resolved here, and frozen into the row
 *
 * `card.status_changed` carries only the before/after STATUS IDS, so this
 * resolves each to its category from `work.statuses` at projection time (a few
 * seconds after the event) and STORES that value. A later re-categorization of
 * the status cannot then rewrite the historical row — the whole reason the
 * column is denormalized (migration 0091's header). A null status id — or one
 * whose row is gone — resolves to 'not_started': a card with no status has not
 * started, and this keeps `to_category` NOT NULL honest without a fourth
 * category the dashboards do not model.
 *
 * ## This is the going-forward half only (§2.1)
 *
 * The outbox-replay backfill (§2.3) and the synthetic creation rows for
 * never-moved cards (§2.2) are a separate slice. From the day this ships,
 * "nothing else is needed" to accumulate history going forward.
 */

/** The consumer name this relay claims under (migration 0091). */
export const ANALYTICS_CONSUMER = 'analytics';

export interface AnalyticsDrainResult {
  readonly processed: number;
  /** Events that wrote a transition row. */
  readonly written: number;
}

type Category = 'not_started' | 'active' | 'done';
const CATEGORIES: ReadonlySet<string> = new Set<Category>(['not_started', 'active', 'done']);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

/** A string field, or null for null/absent/malformed — exactly the shape `before`/`after` (status id or null) need. */
function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

type AnalyticsTx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/**
 * The category of a status id at projection time. `null` id (no status) or a
 * deleted status both resolve to 'not_started' — see the file header.
 */
async function resolveCategory(tx: AnalyticsTx, statusId: string | null): Promise<Category> {
  if (statusId === null) return 'not_started';

  const rows = await tx
    .select({ category: schema.statuses.category })
    .from(schema.statuses)
    .where(eq(schema.statuses.id, statusId))
    .limit(1);

  const category = rows[0]?.category;
  if (category === undefined || !CATEGORIES.has(category)) return 'not_started';
  return category as Category;
}

/**
 * Appends one transition fact row for a `card.status_changed` event.
 *
 * `project_id` comes from the BOARD (the event carries `boardId`), not the
 * card, so a transition still records even if the card was deleted in the
 * window before this tick — the board is the more stable anchor. A transition
 * whose board is also gone is skipped: it cannot be attributed to a project,
 * and both the card and its board vanishing before a ~5s tick is a genuine edge
 * case, not the going-forward path.
 *
 * Exported for the relay's own test and for the future backfill, which drives
 * it with the same shape read from the outbox.
 */
export async function indexCardTransition(orgId: OrgId, row: OutboxRow): Promise<boolean> {
  const record = asRecord(row.payload);
  if (record === null) return false;

  const cardId = str(record, 'cardId');
  const boardId = str(record, 'boardId');
  if (cardId === null || boardId === null) return false;

  return withOrgScope(orgId, async (tx) => {
    const boards = await tx
      .select({ projectId: schema.boards.projectId })
      .from(schema.boards)
      .where(eq(schema.boards.id, boardId))
      .limit(1);

    const board = boards[0];
    if (!board) return false;

    const fromCategory = await resolveCategory(tx, str(record, 'before'));
    const toCategory = await resolveCategory(tx, str(record, 'after'));

    await tx
      .insert(schema.cardTransitions)
      .values({
        id: newId(),
        orgId,
        cardId,
        boardId,
        projectId: board.projectId,
        fromCategory,
        toCategory,
        occurredAt: row.occurredAt,
        synthetic: false,
        sourceEventId: row.id,
      })
      // No target: a redelivered event violates card_transitions_event_key and
      // a re-run backfill violates card_transitions_synthetic_card_key — either
      // way, skip. Idempotency without naming which constraint conflicted.
      .onConflictDoNothing();

    return true;
  });
}

/** Routes one claimed event. Only `card.status_changed` produces a row; everything else is consumed and marked. */
async function handleEvent(row: OutboxRow): Promise<boolean> {
  if (row.name !== cardStatusChanged.name) return false;
  return indexCardTransition(unsafeAsId<'OrgId'>(row.orgId), row);
}

/** One claim-and-process batch. */
export async function drainAnalytics(limit = 100): Promise<AnalyticsDrainResult> {
  return withAuditScope(async (tx) => {
    const claimed = await claimPending(tx, ANALYTICS_CONSUMER, limit);
    if (claimed.length === 0) return { processed: 0, written: 0 };

    let written = 0;
    for (const row of claimed) {
      if (await handleEvent(row)) written += 1;
    }

    await markDispatched(
      tx,
      ANALYTICS_CONSUMER,
      claimed.map((row) => row.id),
    );

    return { processed: claimed.length, written };
  });
}

/** Drains until the backlog is empty. Bounded by `maxBatches`, mirroring `drainSearchIndexFully`. */
export async function drainAnalyticsFully(
  batchSize = 100,
  maxBatches = 50,
): Promise<AnalyticsDrainResult> {
  let processed = 0;
  let written = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await drainAnalytics(batchSize);
    processed += result.processed;
    written += result.written;
    if (result.processed < batchSize) break;
  }

  return { processed, written };
}

/**
 * Runs the analytics drain on the relay tick. Unlike the search indexer (its
 * own gated connection), this drains inside apps/api's existing relay under
 * withAuditScope, so there is no separate database to configure — see migration
 * 0091's header. Logged, never rethrown: a transient blip must not take the
 * tick down, and the events are still there for the next one.
 */
export async function tickAnalytics(logger: Logger): Promise<void> {
  try {
    const result = await drainAnalyticsFully();
    if (result.processed > 0) {
      logger.debug(
        { processed: result.processed, written: result.written },
        'analytics projection drained outbox',
      );
    }
  } catch (error) {
    logger.error({ err: error }, 'analytics projection tick failed');
  }
}
