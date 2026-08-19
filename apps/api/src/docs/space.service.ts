import { asc, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import type { SpaceId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { allowed } from '@taskflow/policy';
import { newId } from '@taskflow/security';
import { spaceArchived, spaceCreated } from './events.js';
import {
  enforceOnSpace,
  envelopeOf,
  loadSpace,
  orgOf,
  spaceTarget,
  type DocsActor,
} from './shared.js';

/**
 * Spaces (ai/phase-6-docs.md §3.1, Wave 1).
 *
 * Deliberately thin: a space has no tree of its own, just a name and an
 * archived flag. Hard delete is not exposed here — see `page.service.ts`'s
 * header on why `page:delete` stays unwired pending §7.5's trash-semantics
 * decision, which applies to spaces for the identical reason.
 */

export async function listSpaces(
  actor: DocsActor,
): Promise<
  readonly { readonly spaceId: string; readonly name: string; readonly archivedAt: Date | null }[]
> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        id: schema.spaces.id,
        /* Selected only so `spaceTarget` can build a real target below — it
           checks the org on every decision, and a target assembled from a
           partial row would have to invent one. */
        orgId: schema.spaces.orgId,
        name: schema.spaces.name,
        archivedAt: schema.spaces.archivedAt,
      })
      .from(schema.spaces)
      .orderBy(asc(schema.spaces.name));

    /* A per-space `can()` filter, NOT a bare return.

       This comment used to argue the opposite — that `route({ permission:
       'space:read' })` was the whole check, because a space carries no
       ancestors or `closed` flag for layer 2 to add. The first half is true
       and the conclusion did not follow: `couldGrant` at the route passes on
       a RELATIONSHIP TUPLE as well as on a role, and `member`'s grant set
       covers every `:read` permission in the catalog by action suffix. So a
       guest holding a `member` tuple on one chat channel — which every user
       who joins a channel holds — cleared the floor here and received every
       space name in the org, having no Docs relationship of any kind.

       Making `space:read` org-level (the fix the telephony routes with the
       same bug got) would be wrong here: a space IS tuple-shareable, and a
       guest holding `viewer` on one space is a state the product supports.
       Filtering is what serves both — `can()` with the space's own target
       answers "role grants it, or a tuple on THIS space does", so the Docs
       guest keeps their one space and the chat guest sees none.

       A bounded loop over the org's spaces, deliberately not a join — the
       same shape and the same reasoning as `search/router.ts`'s per-hit
       check. Spaces are org furniture and there are tens of them, not
       thousands. */
    return rows
      .filter((row) => allowed(actor.subject, 'space:read', spaceTarget(row)))
      .map((row) => ({ spaceId: row.id, name: row.name, archivedAt: row.archivedAt }));
  });
}

export async function createSpace(
  actor: DocsActor,
  input: { readonly name: string },
): Promise<{ readonly spaceId: SpaceId }> {
  const spaceId = newId<'SpaceId'>();
  const orgId = orgOf(actor);
  const userId = actor.subject.userId;

  await withOrgScope(orgId, async (tx) => {
    await tx
      .insert(schema.spaces)
      .values({ id: spaceId, orgId, name: input.name, createdBy: userId });

    await outboxWriter.append(tx, [
      createEvent(spaceCreated, { spaceId, name: input.name }, envelopeOf(actor)),
    ]);
  });

  return { spaceId };
}

export async function archiveSpace(
  actor: DocsActor,
  input: { readonly spaceId: SpaceId; readonly restore: boolean },
): Promise<void> {
  await withOrgScope(orgOf(actor), async (tx) => {
    const space = await loadSpace(tx, input.spaceId);
    enforceOnSpace(actor, 'space:manage', space);

    await tx
      .update(schema.spaces)
      .set({ archivedAt: input.restore ? null : new Date(), updatedAt: new Date() })
      .where(eq(schema.spaces.id, input.spaceId));

    await outboxWriter.append(tx, [
      createEvent(
        spaceArchived,
        { spaceId: input.spaceId, restored: input.restore },
        envelopeOf(actor),
      ),
    ]);
  });
}
