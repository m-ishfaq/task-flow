import { and, eq, isNull, schema, withOrgScope, outboxWriter, type TenantDb } from '@taskflow/db';
import { unsafeAsId, type CardId, type OrgId, type RequestId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { cardPullRequestLinked, cardPullRequestMerged, cardPullRequestUnlinked } from './events.js';
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

/* -------------------------------------------------------------------------- *
 * System callers — the GitHub webhook, not an authenticated actor.
 *
 * Both functions below take an already-open `tx` rather than opening their
 * own `withOrgScope`, and neither takes a `WorkActor` or calls `enforceOn` —
 * there is no human on the other end of an inbound webhook delivery to
 * authorize. `integration-webhooks.ts` calls both from INSIDE its own
 * `withOrgScope` block, the same one that claims the delivery-dedupe row and
 * appends `integration.github_event`, so a card gets linked or notified of a
 * merge in the SAME transaction as the delivery being recorded — a rolled-
 * back delivery (a concurrent claim, a downstream failure) rolls these back
 * with it, and a replayed delivery never reaches either function at all,
 * since the dedupe check runs first.
 * -------------------------------------------------------------------------- */

/**
 * Notifies every card linked to a merged PR — the read half of "auto-move
 * card on PR merge" (`ai/phase-15-ai-copilot-and-permissions.md` §7.2's
 * last documented gap). One `card.pull_request_merged` event per linked
 * card, using the PR-first reverse index migration 0105 built for exactly
 * this ("a future 'PR merged -> move its linked cards' trigger"), never a
 * single event naming several cards — see that event's own doc comment for
 * why. A card that was soft-deleted after being linked is silently skipped:
 * there is nothing left for a rule to act on, and "the card no longer
 * exists" is not a merge-detection failure worth surfacing.
 */
export async function notifyPullRequestMerged(
  tx: TenantDb,
  orgId: OrgId,
  providerScope: string,
  prNumber: number,
  requestId: RequestId,
): Promise<void> {
  const rows = await tx
    .select({ cardId: schema.cardPullRequests.cardId, boardId: schema.cards.boardId })
    .from(schema.cardPullRequests)
    .innerJoin(schema.cards, eq(schema.cards.id, schema.cardPullRequests.cardId))
    .where(
      and(
        eq(schema.cardPullRequests.orgId, orgId),
        eq(schema.cardPullRequests.providerScope, providerScope),
        eq(schema.cardPullRequests.prNumber, prNumber),
        isNull(schema.cards.deletedAt),
      ),
    );

  if (rows.length === 0) return;

  await outboxWriter.append(
    tx,
    rows.map((row) =>
      createEvent(
        cardPullRequestMerged,
        { cardId: row.cardId, boardId: row.boardId, providerScope, prNumber },
        { orgId, actorId: null, requestId },
      ),
    ),
  );
}

/**
 * A card reference at the START of a branch name — `web-142-fix-x` names
 * `WEB-142`, the exact inverse of `branch.service.ts`'s own
 * `<reference>-<slug>` naming (that file's `slugify` lowercases and
 * hyphenates; a project key is `[A-Z][A-Z0-9]{1,9}` per `router.ts`'s own
 * `ProjectKey` schema, so the pattern below is that schema's shape,
 * case-insensitive, anchored to the start). Deliberately narrower than
 * scanning the whole branch name for an embedded reference anywhere in
 * it — a key that happens to appear mid-name unrelated to a real reference
 * would be a false positive, and this codebase's own branch-naming
 * convention already puts the reference first.
 */
const BRANCH_REFERENCE_PATTERN = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)(?:[-_]|$)/;

function referenceFromBranchName(branchName: string): { key: string; number: number } | null {
  const match = BRANCH_REFERENCE_PATTERN.exec(branchName);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { key: match[1].toUpperCase(), number: Number.parseInt(match[2], 10) };
}

/**
 * Auto-links a PR to the card its own HEAD BRANCH names, if any — the write
 * half of "auto-link PR to card by branch name." A no-op, never an error,
 * when the branch carries no recognizable reference or names a card this
 * org does not have: most PRs are not opened from a reference-shaped
 * branch, and that is the ordinary case, not a failure one.
 *
 * Unlike `linkCardPullRequest` (which emits `card.pull_request_linked`
 * unconditionally, even when the row already existed — see that function's
 * own test), this checks `.returning()` and only emits when a row was
 * actually inserted. `linkCardPullRequest`'s looser behavior is safe there
 * because a human clicking "Link" twice is a rare, deliberate retry; this
 * function runs on every `opened` webhook delivery for every PR an org
 * receives, so emitting unconditionally would mean the SAME merge-audit
 * shape as a real duplicate the moment GitHub redelivers (rare, but real)
 * or a caller widens the trigger action beyond `opened` later.
 */
export async function autoLinkPullRequestFromBranchName(
  tx: TenantDb,
  orgId: OrgId,
  providerScope: string,
  prNumber: number,
  branchName: string,
  requestId: RequestId,
): Promise<void> {
  const reference = referenceFromBranchName(branchName);
  if (reference === null) return;

  const rows = await tx
    .select({ cardId: schema.cards.id, boardId: schema.cards.boardId })
    .from(schema.cards)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.cards.projectId))
    .where(
      and(
        eq(schema.cards.orgId, orgId),
        eq(schema.projects.key, reference.key),
        eq(schema.cards.number, reference.number),
        isNull(schema.cards.deletedAt),
      ),
    )
    .limit(1);

  const card = rows[0];
  if (card === undefined) return;

  const cardId = unsafeAsId<'CardId'>(card.cardId);
  const boardId = unsafeAsId<'BoardId'>(card.boardId);

  const inserted = await tx
    .insert(schema.cardPullRequests)
    .values({ orgId, cardId, providerScope, prNumber, linkedBy: null })
    .onConflictDoNothing()
    .returning({ cardId: schema.cardPullRequests.cardId });

  if (inserted.length === 0) return;

  await outboxWriter.append(tx, [
    createEvent(
      cardPullRequestLinked,
      { cardId, boardId, providerScope, prNumber },
      { orgId, actorId: null, requestId },
    ),
  ]);
}
