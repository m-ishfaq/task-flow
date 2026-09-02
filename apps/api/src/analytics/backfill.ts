import { eq, and, isNull, withOrgScope, schema } from '@taskflow/db';
import type { OrgId } from '@taskflow/contracts';
import { newId } from '@taskflow/security';

/**
 * Analytics backfill (Phase 11 Wave 2, ai/phase-11-analytics.md §2.2).
 *
 * Creates synthetic creation rows for cards that existed before the analytics
 * projection shipped and were never moved. A card's first appearance IS a
 * transition — from nothing into its initial status — so the backfill
 * synthesizes one from the card's `created_at` and `status_id`.
 *
 * The going-forward relay (§2.1) handles every card moved AFTER this ships.
 * The outbox replay (§2.3) is unnecessary: the relay already drains
 * `card.status_changed` events from the outbox, so historical events are
 * replayed by the first tick.
 *
 * Safe to re-run: `ON CONFLICT DO NOTHING` against the partial unique on
 * (org_id, card_id) WHERE synthetic.
 */

export interface BackfillResult {
  /** Cards that received a synthetic creation row. */
  readonly syntheticCreated: number;
}

/**
 * Creates synthetic creation rows for cards that have no transition row yet.
 *
 * A LEFT JOIN + IS NULL finds cards whose id never appeared in
 * `card_transitions` — the exact set §2.2 describes. Each gets a row with
 * `from_category = NULL`, `synthetic = true`, `source_event_id = NULL`.
 *
 * The status category is resolved from `work.statuses` at backfill time,
 * frozen into the row the same way the relay freezes it: a later
 * re-categorization of the status cannot rewrite the historical row.
 * A null status id → 'not_started' (same as the relay's resolveCategory).
 */
export async function backfillSyntheticCreationRows(orgId: OrgId): Promise<number> {
  return withOrgScope(orgId, async (tx) => {
    const unmovedCards = await tx
      .select({
        id: schema.cards.id,
        boardId: schema.cards.boardId,
        projectId: schema.cards.projectId,
        statusId: schema.cards.statusId,
        createdAt: schema.cards.createdAt,
      })
      .from(schema.cards)
      .leftJoin(
        schema.cardTransitions,
        and(
          eq(schema.cardTransitions.cardId, schema.cards.id),
          eq(schema.cardTransitions.orgId, orgId),
        ),
      )
      .where(isNull(schema.cardTransitions.id));

    let created = 0;

    for (const card of unmovedCards) {
      let category: 'not_started' | 'active' | 'done' = 'not_started';

      if (card.statusId !== null) {
        const statusRows = await tx
          .select({ category: schema.statuses.category })
          .from(schema.statuses)
          .where(eq(schema.statuses.id, card.statusId))
          .limit(1);

        const resolved = statusRows[0]?.category;
        if (resolved === 'active' || resolved === 'done' || resolved === 'not_started') {
          category = resolved;
        }
      }

      await tx
        .insert(schema.cardTransitions)
        .values({
          id: newId(),
          orgId,
          cardId: card.id,
          boardId: card.boardId,
          projectId: card.projectId,
          fromCategory: null,
          toCategory: category,
          occurredAt: card.createdAt,
          synthetic: true,
          sourceEventId: null,
        })
        .onConflictDoNothing();

      created += 1;
    }

    return created;
  });
}
