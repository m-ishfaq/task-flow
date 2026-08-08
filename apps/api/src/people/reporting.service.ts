import { and, eq, schema, withOrgScope, outboxWriter, type TenantDb } from '@taskflow/db';
import { errors, type OrgId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { reportingLineChanged } from './events.js';
import type { PeopleActor } from './profile.service.js';

/**
 * Reporting lines — the org chart's edges (ai/phase-11.5-people.md §3.6,
 * Wave 2).
 *
 * Two layers enforce the two things that can go wrong:
 *
 *   - CONTAINMENT comes from the schema. `manager_user_id` is a composite FK
 *     to `identity.memberships (org_id, user_id)`, so a manager who is a
 *     member of a DIFFERENT org is refused by the database (migration 0031)
 *     — no service lookup that someone could forget to write.
 *   - ACYCLICITY comes from THIS service. The database has no constraint
 *     language for "not reachable from here going up", so the write walks
 *     the proposed manager's chain upward and refuses if the subject appears
 *     anywhere in it — the identical problem Docs' page tree solves for
 *     `movePage`, solved the identical way. The direct self-report is caught
 *     by the first hop of the same walk (and by the CHECK as a backstop).
 *
 * Setting a reporting line is never self-service: the route is
 * `member:manage`, unconditionally, with no author-exception (§3.6 — nobody
 * assigns their own manager, mirroring "nobody changes their own role").
 */

/**
 * Sets (or clears, with null) who a member reports to.
 *
 * A chain-walk bound of 100 hops is a safety valve against a bug elsewhere
 * producing a chain that never terminates — not a belief that a legitimate
 * org chart could be that deep.
 */
export async function setReportingLine(
  orgId: OrgId,
  actor: PeopleActor,
  input: { readonly userId: string; readonly managerUserId: string | null },
): Promise<{ readonly before: string | null; readonly after: string | null }> {
  return withOrgScope(orgId, async (tx) => {
    const targets = await tx
      .select({ userId: schema.memberships.userId })
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, input.userId)),
      )
      .limit(1);
    if (!targets[0]) throw errors.notFound();

    if (input.managerUserId !== null) {
      await assertNoCycle(tx, orgId, input.userId, input.managerUserId);
    }

    const rows = await tx
      .select({ managerUserId: schema.membershipProfiles.managerUserId })
      .from(schema.membershipProfiles)
      .where(
        and(
          eq(schema.membershipProfiles.orgId, orgId),
          eq(schema.membershipProfiles.userId, input.userId),
        ),
      )
      .limit(1);

    const existing = rows[0];
    const before = existing?.managerUserId ?? null;
    const after = input.managerUserId;
    if (before === after) return { before, after };

    const now = new Date();
    if (existing !== undefined) {
      await tx
        .update(schema.membershipProfiles)
        .set({ managerUserId: after, updatedAt: now })
        .where(
          and(
            eq(schema.membershipProfiles.orgId, orgId),
            eq(schema.membershipProfiles.userId, input.userId),
          ),
        );
    } else {
      await tx
        .insert(schema.membershipProfiles)
        .values({ orgId, userId: input.userId, managerUserId: after, updatedAt: now });
    }

    await outboxWriter.append(tx, [
      createEvent(
        reportingLineChanged,
        { orgId, userId: input.userId, before, after },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { before, after };
  });
}

/**
 * Refuses a write that would make `userId` its own ancestor (manager-of-
 * manager-of-... of itself).
 *
 * Walks upward from the PROPOSED manager, not from the subject: the existing
 * chain above the subject is already acyclic (every write validated), so a
 * cycle can only enter through the new edge. Direct self-report
 * (`managerUserId === userId`) fails on the first hop. Bounded at 100 hops.
 */
async function assertNoCycle(
  tx: TenantDb,
  orgId: OrgId,
  userId: string,
  managerUserId: string,
): Promise<void> {
  let current: string = managerUserId;

  for (let hops = 0; hops < 100; hops += 1) {
    if (current === userId) {
      throw errors.validation({
        managerUserId: 'That would make the member their own manager.',
      });
    }

    const rows = await tx
      .select({ managerUserId: schema.membershipProfiles.managerUserId })
      .from(schema.membershipProfiles)
      .where(
        and(
          eq(schema.membershipProfiles.orgId, orgId),
          eq(schema.membershipProfiles.userId, current),
        ),
      )
      .limit(1);

    const next = rows[0]?.managerUserId ?? null;
    // No further manager above this member — the walk is done, and the
    // subject never appeared in it, so the edge is safe to add.
    if (next === null) return;
    current = next;
  }

  /* Unreachable for a legitimate org chart. Not a validation error — a chain
     this deep means the acyclicity invariant broke somewhere, which is a
     server-side bug worth surfacing as such. */
  throw errors.conflict('The reporting chain is too deep to resolve. Please contact support.');
}
