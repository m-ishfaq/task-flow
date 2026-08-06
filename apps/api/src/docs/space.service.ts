import { asc, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import type { SpaceId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { spaceArchived, spaceCreated } from './events.js';
import { enforceOnSpace, envelopeOf, loadSpace, orgOf, type DocsActor } from './shared.js';

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
): Promise<readonly { readonly spaceId: string; readonly name: string; readonly archivedAt: Date | null }[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({ id: schema.spaces.id, name: schema.spaces.name, archivedAt: schema.spaces.archivedAt })
      .from(schema.spaces)
      .orderBy(asc(schema.spaces.name));

    /* No `enforce` here: `space:read` was already checked at the route (layer
       1), and a space carries no ancestors or `closed` flag that layer 2 could
       add — unlike a channel, listing spaces IS the org role's decision.
       `route({ permission: 'space:read' })` is therefore not "barely
       narrowing", the way chat/router.ts warns its own gate is; for spaces it
       is the whole check. */
    return rows.map((row) => ({ spaceId: row.id, name: row.name, archivedAt: row.archivedAt }));
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
    await tx.insert(schema.spaces).values({ id: spaceId, orgId, name: input.name, createdBy: userId });

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
