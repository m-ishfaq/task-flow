import { and, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import type { CardId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { cardPullRequestLinked, cardPullRequestUnlinked } from './events.js';
import { loadCard } from './card.service.js';
import { ancestorsOfCard, enforceOn, envelopeOf, orgOf, userOf, type WorkActor } from './shared.js';

/**
 * The card <-> GitHub PR link (ai/phase-15-ai-copilot-and-permissions.md
 * §7.2 — "a new small table linking a card to a PR"; migration 0105).
 *
 * ## `card:update`, not a new permission
 *
 * Linking a PR is filling in a fact about ONE card — the identical
 * `card:update` shape `checklist.service.ts`'s own header already gives for
 * "a checklist is part of its card, not a resource anyone grants access to
 * separately." It is deliberately NOT also gated on `pr:view`: nothing here
 * reads from GitHub at all (no fetch, no token use), so requiring a SECOND
 * permission would refuse a Member who can already edit the card from
 * recording a fact they already know (their own branch name, a mention in
 * chat) for no authorization reason — `pr:view` exists to gate seeing PR
 * CONTENT, which this never touches.
 *
 * ## `providerScope` is caller-supplied here, unlike every PR read/write tool
 *
 * `pr-read.service.ts`/`pr-write.service.ts` always resolve the repo via
 * `connectedGithubRepo`, never from caller input — because THEY use it to
 * build a real GitHub API URL, where a caller-supplied scope would be a
 * path-traversal-shaped redirection risk (`repoPath`'s own doc comment).
 * This service makes no such call; `providerScope` is inert data written to
 * one row. The one caller today (`apps/ai/tools/pr.ts`'s `card_link_pr`)
 * still resolves it from the org's own connector before calling this, for a
 * different reason: consistency with what a person sees when they open the
 * PR (the same `owner/repo` the read tools already show), not because an
 * arbitrary string here would be unsafe.
 *
 * ## No existence check against GitHub
 *
 * A deliberate, narrower scope: unlike a label or sprint id (checked against
 * a local table, so a fabricated one fails a real foreign key), a PR number
 * has no local row to validate against, and verifying it would mean a
 * second permission (`pr:view`) plus a real network call just to record a
 * claim. The link is exactly that — a claim a person or the assistant can
 * make and later correct — not a synchronized mirror of GitHub's own state.
 */

export interface LinkedPullRequest {
  readonly providerScope: string;
  readonly prNumber: number;
  readonly linkedBy: string | null;
  readonly linkedAt: Date;
}

export async function listCardPullRequests(
  actor: WorkActor,
  input: { readonly cardId: CardId },
): Promise<readonly LinkedPullRequest[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const card = await loadCard(tx, input.cardId);
    enforceOn(actor, 'card:read', { type: 'card', id: input.cardId }, card, ancestorsOfCard(card));

    const rows = await tx
      .select({
        providerScope: schema.cardPullRequests.providerScope,
        prNumber: schema.cardPullRequests.prNumber,
        linkedBy: schema.cardPullRequests.linkedBy,
        linkedAt: schema.cardPullRequests.linkedAt,
      })
      .from(schema.cardPullRequests)
      .where(eq(schema.cardPullRequests.cardId, input.cardId))
      .orderBy(schema.cardPullRequests.linkedAt);

    return rows;
  });
}

export async function linkCardPullRequest(
  actor: WorkActor,
  input: { readonly cardId: CardId; readonly providerScope: string; readonly prNumber: number },
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

    /* Idempotent, the same shape `memberGrants.grant`/`revoke` already use for
       a retried batch: linking a PR that is already linked is not a
       different fact, and a second `card_link_pr` call for the same
       reference should not fail or duplicate the row. */
    await tx
      .insert(schema.cardPullRequests)
      .values({
        orgId,
        cardId: input.cardId,
        providerScope: input.providerScope,
        prNumber: input.prNumber,
        linkedBy: userOf(actor),
      })
      .onConflictDoNothing();

    await outboxWriter.append(tx, [
      createEvent(
        cardPullRequestLinked,
        {
          cardId: input.cardId,
          boardId: card.boardId,
          providerScope: input.providerScope,
          prNumber: input.prNumber,
        },
        envelopeOf(actor),
      ),
    ]);
  });

  return { linked: true };
}

export async function unlinkCardPullRequest(
  actor: WorkActor,
  input: { readonly cardId: CardId; readonly providerScope: string; readonly prNumber: number },
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
      .delete(schema.cardPullRequests)
      .where(
        and(
          eq(schema.cardPullRequests.cardId, input.cardId),
          eq(schema.cardPullRequests.providerScope, input.providerScope),
          eq(schema.cardPullRequests.prNumber, input.prNumber),
        ),
      )
      .returning({ cardId: schema.cardPullRequests.cardId });

    if (deleted.length === 0) return { unlinked: false };

    await outboxWriter.append(tx, [
      createEvent(
        cardPullRequestUnlinked,
        {
          cardId: input.cardId,
          boardId: card.boardId,
          providerScope: input.providerScope,
          prNumber: input.prNumber,
        },
        envelopeOf(actor),
      ),
    ]);

    return { unlinked: true };
  });
}
