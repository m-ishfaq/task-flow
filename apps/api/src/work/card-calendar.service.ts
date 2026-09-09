import { and, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import type { CardId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { cardCalendarSyncToggled } from './events.js';
import { loadCard } from './card.service.js';
import { ancestorsOfCard, enforceOn, envelopeOf, orgOf, userOf, type WorkActor } from './shared.js';

/**
 * Per-card calendar sync — the opt-in-per-event shape chosen explicitly by
 * the project owner over a default "assigned to me" scope: a small icon on
 * the card lets anyone who can see it add that ONE card to their own
 * calendar feed, and nothing else about them changes.
 *
 * ## `card:read`, not `card:update` — deciding to watch is not editing
 *
 * The identical reasoning `standup/subscription.service.ts` already gives
 * for "email me this project's standup": if you can already see the card,
 * deciding to put it on your OWN calendar needs no extra permission beyond
 * the read permission that already let you see it. This is self-referential
 * ONLY — `toggleCalendarSync` always acts on the CALLER's own subscription
 * row, never a `userId` field a caller could name someone else with.
 *
 * ## Idempotent, and reported as a fact rather than an error
 *
 * Toggling twice in a row (a double-click, a retried request) lands on
 * whichever state the second call actually names — `synced: true` inserts
 * (idempotent via `onConflictDoNothing`), `synced: false` deletes
 * (idempotent — deleting an absent row is not an error). Both still emit an
 * event: guardrail 6 asks for one per state-mutating call, and a toggle that
 * turned out to be a no-op is still worth a row in the audit trail saying a
 * person acted, even if the state did not visibly change.
 */

export async function toggleCalendarSync(
  actor: WorkActor,
  input: { readonly cardId: CardId; readonly synced: boolean },
): Promise<{ readonly synced: boolean }> {
  const orgId = orgOf(actor);
  const userId = userOf(actor);

  return withOrgScope(orgId, async (tx) => {
    const card = await loadCard(tx, input.cardId);
    enforceOn(actor, 'card:read', { type: 'card', id: input.cardId }, card, ancestorsOfCard(card));

    if (input.synced) {
      await tx
        .insert(schema.cardCalendarSubscriptions)
        .values({
          id: newId<'CardCalendarSubscriptionId'>(),
          orgId,
          cardId: input.cardId,
          userId,
        })
        .onConflictDoNothing();
    } else {
      await tx
        .delete(schema.cardCalendarSubscriptions)
        .where(
          and(
            eq(schema.cardCalendarSubscriptions.cardId, input.cardId),
            eq(schema.cardCalendarSubscriptions.userId, userId),
          ),
        );
    }

    await outboxWriter.append(tx, [
      createEvent(
        cardCalendarSyncToggled,
        { cardId: input.cardId, boardId: card.boardId, userId, synced: input.synced },
        envelopeOf(actor),
      ),
    ]);

    return { synced: input.synced };
  });
}

/** Whether the CALLER themselves has this card on their calendar. */
export async function isCalendarSynced(
  actor: WorkActor,
  input: { readonly cardId: CardId },
): Promise<boolean> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({ id: schema.cardCalendarSubscriptions.id })
      .from(schema.cardCalendarSubscriptions)
      .where(
        and(
          eq(schema.cardCalendarSubscriptions.cardId, input.cardId),
          eq(schema.cardCalendarSubscriptions.userId, userOf(actor)),
        ),
      )
      .limit(1);

    return rows.length > 0;
  });
}
