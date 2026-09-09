import { and, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type OrgId, type UserId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { isRelation, RESOURCE_TYPES, type ResourceType } from '@taskflow/policy';
import { grantCreated, grantRevoked } from './events.js';
import type { Actor } from './org.service.js';

/**
 * Relationship grants — writing the tuples the policy engine reads (§8.2).
 *
 * Two validations here look like belt-and-braces next to the CHECK constraints
 * in migration 0005, and are not. The constraint rejects a value the database
 * has never heard of; these reject a value THIS BUILD has never heard of, which
 * is a different set during a rolling deploy. A tuple stored with a relation the
 * running policy engine does not recognize grants nothing and explains nothing
 * — it is invisible in every decision trace, which makes "why can't they see
 * it" unanswerable.
 */

export interface GrantInput {
  readonly subjectType: 'user' | 'team';
  readonly subjectId: string;
  readonly relation: string;
  readonly objectType: string;
  readonly objectId: string;
  /** ISO timestamp, or null for a grant that does not lapse. */
  readonly expiresAt: string | null;
  /**
   * Marks the tuple as issued through a guest-invite flow rather than the
   * generic Share dialog. Purely a review/audit marker — migration
   * `authz.relationship_tuples.is_guest`'s own comment states it changes
   * nothing about how `can()` reads the tuple. Defaults to `false` so every
   * existing caller of `grant()` is unaffected.
   */
  readonly isGuest?: boolean;
}

function isResourceType(value: string): value is ResourceType {
  return (RESOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * Grants a relation on one object.
 *
 * Idempotent by the unique index on (org, subject, relation, object): granting
 * the same thing twice is one row, not two. That matters to the engine, which
 * caps a subject when EVERY tuple at the nearest distance is restrictive — a
 * duplicate `viewer` row must not change that arithmetic.
 */
export async function grant(
  orgId: OrgId,
  input: GrantInput,
  actor: Actor,
): Promise<{ readonly tupleId: string }> {
  if (!isRelation(input.relation)) {
    throw errors.validation({ relation: 'Unknown relation.' });
  }
  if (!isResourceType(input.objectType)) {
    throw errors.validation({ objectType: 'Unknown resource type.' });
  }

  const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
  if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
    throw errors.validation({ expiresAt: 'Not a valid timestamp.' });
  }
  // A grant that expired before it was made is almost certainly a timezone
  // mistake, and it would sit in the table looking like access that exists.
  if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
    throw errors.validation({ expiresAt: 'Expiry must be in the future.' });
  }

  return withOrgScope(orgId, async (tx) => {
    await assertSubjectBelongsHere(tx, input);

    const existing = await tx
      .select({ id: schema.relationshipTuples.id })
      .from(schema.relationshipTuples)
      .where(
        and(
          eq(schema.relationshipTuples.subjectType, input.subjectType),
          eq(schema.relationshipTuples.subjectId, input.subjectId),
          eq(schema.relationshipTuples.relation, input.relation),
          eq(schema.relationshipTuples.objectType, input.objectType),
          eq(schema.relationshipTuples.objectId, input.objectId),
        ),
      )
      .limit(1);

    const found = existing[0];
    if (found) return { tupleId: found.id };

    const tupleId = newId<'TupleId'>();
    await tx.insert(schema.relationshipTuples).values({
      id: tupleId,
      orgId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      relation: input.relation,
      objectType: input.objectType,
      objectId: input.objectId,
      grantedBy: actor.userId,
      expiresAt,
      isGuest: input.isGuest ?? false,
    });

    await outboxWriter.append(tx, [
      createEvent(
        grantCreated,
        {
          tupleId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          relation: input.relation,
          objectType: input.objectType,
          objectId: input.objectId,
          expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
          isGuest: input.isGuest ?? false,
        },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { tupleId };
  });
}

export async function revoke(
  orgId: OrgId,
  input: { readonly tupleId: string },
  actor: Actor,
): Promise<{ readonly revoked: true }> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.relationshipTuples.id,
        subjectType: schema.relationshipTuples.subjectType,
        subjectId: schema.relationshipTuples.subjectId,
        relation: schema.relationshipTuples.relation,
        objectType: schema.relationshipTuples.objectType,
        objectId: schema.relationshipTuples.objectId,
      })
      .from(schema.relationshipTuples)
      .where(eq(schema.relationshipTuples.id, input.tupleId))
      .limit(1);

    const tuple = rows[0];
    if (!tuple) throw errors.notFound();

    await tx.delete(schema.relationshipTuples).where(eq(schema.relationshipTuples.id, tuple.id));

    await outboxWriter.append(tx, [
      createEvent(
        grantRevoked,
        {
          tupleId: tuple.id,
          subjectType: tuple.subjectType === 'team' ? 'team' : 'user',
          subjectId: tuple.subjectId,
          relation: tuple.relation,
          objectType: tuple.objectType,
          objectId: tuple.objectId,
        },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { revoked: true as const };
  });
}

export interface GrantSummary {
  readonly tupleId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly relation: string;
  readonly expiresAt: Date | null;
}

/** Who has access to one object — the reverse question the debug page asks (§10.7). */
export async function listGrantsOn(
  orgId: OrgId,
  object: { readonly objectType: string; readonly objectId: string },
): Promise<readonly GrantSummary[]> {
  return withOrgScope(orgId, async (tx) =>
    tx
      .select({
        tupleId: schema.relationshipTuples.id,
        subjectType: schema.relationshipTuples.subjectType,
        subjectId: schema.relationshipTuples.subjectId,
        relation: schema.relationshipTuples.relation,
        expiresAt: schema.relationshipTuples.expiresAt,
      })
      .from(schema.relationshipTuples)
      .where(
        and(
          eq(schema.relationshipTuples.objectType, object.objectType),
          eq(schema.relationshipTuples.objectId, object.objectId),
        ),
      ),
  );
}

/**
 * Refuses to grant to a subject outside this organization.
 *
 * RLS already confines the tuple ROW to this org, so a cross-tenant grant
 * cannot be read by anyone else. What it does not prevent is writing a tuple
 * naming a user id from another tenant — which would be inert today and would
 * silently become live access the moment that person was ever added here. A
 * grant whose subject nobody can see is also invisible on the debug page, so
 * nothing would ever surface it.
 */
async function assertSubjectBelongsHere(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  input: GrantInput,
): Promise<void> {
  if (input.subjectType === 'user') {
    const rows = await tx
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, input.subjectId as UserId))
      .limit(1);
    if (!rows[0]) throw errors.notFound();
    return;
  }

  const rows = await tx
    .select({ id: schema.teams.id })
    .from(schema.teams)
    .where(eq(schema.teams.id, input.subjectId))
    .limit(1);
  if (!rows[0]) throw errors.notFound();
}
