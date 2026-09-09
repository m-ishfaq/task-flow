import { and, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import type { CardId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { cardBranchLinked, cardBranchUnlinked } from './events.js';
import { loadCard } from './card.service.js';
import { ancestorsOfCard, enforceOn, envelopeOf, orgOf, userOf, type WorkActor } from './shared.js';

/**
 * The card <-> git branch link (ai/phase-15-ai-copilot-and-permissions.md
 * §7.2; migration 0106) — the identical shape `card-pull-request.service.ts`
 * already gives for a PR link, one entity type over. Read this file's own
 * header for the reasoning that applies unchanged here: `card:update`, not a
 * new permission (recording which branch belongs to a card is filling in a
 * fact about ONE card); no existence check against GitHub for a MANUALLY
 * supplied link (there is none here — see below); idempotent inserts.
 *
 * ## `linkCardBranch` has exactly one real caller, unlike `linkCardPullRequest`
 *
 * There is no "link an existing branch by name" UI or tool the way
 * `card_link_pr` lets someone claim a PR NUMBER with no GitHub round trip —
 * a branch is always created THROUGH `automation/branch.service.ts`'s
 * `createBranchFromCard`, which calls this function itself immediately after
 * the real GitHub ref is confirmed to exist (either just-created, or already
 * there). This function still re-checks `card:update` on its own, the same
 * defense-in-depth every function in this registry keeps even when it has
 * exactly one caller today — a second caller (a future "link an existing
 * branch" route) must not silently inherit whatever check its first caller
 * happened to already perform.
 */

export interface LinkedBranch {
  readonly providerScope: string;
  readonly branchName: string;
  readonly linkedBy: string | null;
  readonly linkedAt: Date;
}

export async function listCardBranches(
  actor: WorkActor,
  input: { readonly cardId: CardId },
): Promise<readonly LinkedBranch[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const card = await loadCard(tx, input.cardId);
    enforceOn(actor, 'card:read', { type: 'card', id: input.cardId }, card, ancestorsOfCard(card));

    const rows = await tx
      .select({
        providerScope: schema.cardBranches.providerScope,
        branchName: schema.cardBranches.branchName,
        linkedBy: schema.cardBranches.linkedBy,
        linkedAt: schema.cardBranches.linkedAt,
      })
      .from(schema.cardBranches)
      .where(eq(schema.cardBranches.cardId, input.cardId))
      .orderBy(schema.cardBranches.linkedAt);

    return rows;
  });
}

export async function linkCardBranch(
  actor: WorkActor,
  input: { readonly cardId: CardId; readonly providerScope: string; readonly branchName: string },
): Promise<{ readonly linked: true }> {
  const orgId = orgOf(actor);

  await withOrgScope(orgId, async (tx) => {
    const card = await loadCard(tx, input.cardId);
    enforceOn(
      actor,
      'card:update',
      { type: 'card', id: input.cardId },
      card,
      ancestorsOfCard(card),
    );

    /* Idempotent, the same shape `linkCardPullRequest` already uses: linking
       a branch that is already linked is not a different fact, and a retried
       `createBranchFromCard` confirmation should not fail or duplicate the
       row. */
    await tx
      .insert(schema.cardBranches)
      .values({
        orgId,
        cardId: input.cardId,
        providerScope: input.providerScope,
        branchName: input.branchName,
        linkedBy: userOf(actor),
      })
      .onConflictDoNothing();

    await outboxWriter.append(tx, [
      createEvent(
        cardBranchLinked,
        {
          cardId: input.cardId,
          boardId: card.boardId,
          providerScope: input.providerScope,
          branchName: input.branchName,
        },
        envelopeOf(actor),
      ),
    ]);
  });

  return { linked: true };
}

export async function unlinkCardBranch(
  actor: WorkActor,
  input: { readonly cardId: CardId; readonly providerScope: string; readonly branchName: string },
): Promise<{ readonly unlinked: boolean }> {
  const orgId = orgOf(actor);

  return withOrgScope(orgId, async (tx) => {
    const card = await loadCard(tx, input.cardId);
    enforceOn(
      actor,
      'card:update',
      { type: 'card', id: input.cardId },
      card,
      ancestorsOfCard(card),
    );

    const deleted = await tx
      .delete(schema.cardBranches)
      .where(
        and(
          eq(schema.cardBranches.cardId, input.cardId),
          eq(schema.cardBranches.providerScope, input.providerScope),
          eq(schema.cardBranches.branchName, input.branchName),
        ),
      )
      .returning({ cardId: schema.cardBranches.cardId });

    if (deleted.length === 0) return { unlinked: false };

    await outboxWriter.append(tx, [
      createEvent(
        cardBranchUnlinked,
        {
          cardId: input.cardId,
          boardId: card.boardId,
          providerScope: input.providerScope,
          branchName: input.branchName,
        },
        envelopeOf(actor),
      ),
    ]);

    return { unlinked: true };
  });
}
