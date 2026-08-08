import { and, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type OrgId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { membershipProfileUpdated } from './events.js';
import type { PeopleActor } from './profile.service.js';

/**
 * A membership's org-scoped profile fields — job title and department
 * (ai/phase-11.5-people.md §3.6, Wave 2).
 *
 * Reachable by two different routes with two different subjects:
 *
 *   - `people.profile.update` (selfRoute) for one's OWN fields — job title is
 *     self-service, cosmetic, self-asserted text with the same safety
 *     argument display_name already has (§3.6).
 *   - `people.membershipProfile.update` (`member:manage`) for another
 *     member's fields, which is the admin edit affordance.
 *
 * Both land here. The permission difference is decided at the route — which
 * subject the caller is allowed to name — and the write is identical.
 * `withOrgScope` + the tenant RLS policy on `people.membership_profiles` is
 * what stops an admin of org A from naming org B's membership rows at all
 * (migration 0031's header).
 */

export interface MembershipPatch {
  /* The explicit `| undefined` exists only to keep a zod-parsed patch
     assignable under `exactOptionalPropertyTypes`; zod strips absent keys,
     so `!== undefined` below IS presence (see profile.service.ts's patch
     doc for the same reasoning). */
  readonly jobTitle?: string | null | undefined;
  readonly department?: string | null | undefined;
}

const FIELDS = ['jobTitle', 'department'] as const;

/**
 * Sets or clears a member's job title/department in one org.
 *
 * The membership must exist (NOT_FOUND otherwise — never a message naming the
 * person, which across tenants would confirm an account exists). Writes are
 * an upsert on `(org_id, user_id)`, so a member who has set nothing gets a
 * lazy row exactly like `people.profiles` (absent row = all nulls).
 */
export async function updateMembershipProfile(
  orgId: OrgId,
  actor: PeopleActor,
  targetUserId: string,
  patch: MembershipPatch,
): Promise<{ readonly changed: readonly string[] }> {
  return withOrgScope(orgId, async (tx) => {
    const members = await tx
      .select({ userId: schema.memberships.userId })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, targetUserId)))
      .limit(1);
    if (!members[0]) throw errors.notFound();

    const rows = await tx
      .select({
        jobTitle: schema.membershipProfiles.jobTitle,
        department: schema.membershipProfiles.department,
      })
      .from(schema.membershipProfiles)
      .where(
        and(
          eq(schema.membershipProfiles.orgId, orgId),
          eq(schema.membershipProfiles.userId, targetUserId),
        ),
      )
      .limit(1);

    const existing = rows[0];
    const before = {
      jobTitle: existing?.jobTitle ?? null,
      department: existing?.department ?? null,
    };
    const after = { ...before };
    if ('jobTitle' in patch) after.jobTitle = normalizeText(patch.jobTitle, 'jobTitle', 120);
    if ('department' in patch)
      after.department = normalizeText(patch.department, 'department', 120);

    const changed = FIELDS.filter((field) => (before[field] ?? null) !== (after[field] ?? null));
    if (changed.length === 0) return { changed: [] };

    const now = new Date();
    if (existing !== undefined) {
      await tx
        .update(schema.membershipProfiles)
        .set({ ...after, updatedAt: now })
        .where(
          and(
            eq(schema.membershipProfiles.orgId, orgId),
            eq(schema.membershipProfiles.userId, targetUserId),
          ),
        );
    } else {
      await tx
        .insert(schema.membershipProfiles)
        .values({ orgId, userId: targetUserId, ...after, updatedAt: now });
    }

    await outboxWriter.append(tx, [
      createEvent(
        membershipProfileUpdated,
        { orgId, userId: targetUserId, changed, before, after },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { changed };
  });
}

function normalizeText(
  value: string | null | undefined,
  field: string,
  max: number,
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) {
    throw errors.validation({ [field]: `This can be at most ${String(max)} characters.` });
  }
  return trimmed;
}
