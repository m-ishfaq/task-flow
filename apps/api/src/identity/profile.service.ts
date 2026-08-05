import { createEvent } from '@taskflow/events';
import { errors, type UserId } from '@taskflow/contracts';
import * as identityEvents from './events.js';
import * as repo from './repository.js';
import type { IdentityDeps } from './identity.service.js';
import { SYSTEM_ORG } from './identity.service.js';

/**
 * A person's own profile (migration 0019, PLAN.md §3.6).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2): this lives in `apps/api/src/identity`. The
 * change itself is small — one nullable, non-unique text column — but the
 * directory is on the allowlist and the reason applies here too: anything that
 * writes to `identity.users` is one edit away from writing to a column that
 * decides who someone is.
 *
 * ## A display name is not an identifier, and nothing may treat it as one
 *
 * It is not unique, it is not indexed for lookup, and no code path finds a user
 * by it. `resolveOrgMembership` keys on the user id and `findUserByEmail` on
 * `email_normalized`; both are untouched by this file. That separation is the
 * whole safety argument, because a display name is fully attacker-controlled
 * text — someone can call themselves another person's email address, or the
 * word "Admin", and none of it reaches an authorization decision. It reaches a
 * label, and a label is all it may ever reach.
 *
 * The one place that needs care is rendering: a name is user-supplied content,
 * so it goes through React's own escaping like any other string. There is no
 * `dangerouslySetInnerHTML` anywhere in this codebase (CLAUDE.md rule 4) and
 * this must not become the reason for the first one.
 */

export interface UpdateProfileInput {
  /**
   * The new name, or null to clear it.
   *
   * Null is a real value here rather than "leave it alone": clearing a name and
   * going back to being shown by address is something a person can want, and a
   * schema where null meant "unchanged" would make it unexpressible.
   */
  readonly displayName: string | null;
}

/**
 * Sets the caller's own display name.
 *
 * Takes the user id from the authenticated principal at the route, never from
 * the input — there is no field in `UpdateProfileInput` naming a user, and there
 * must never be one. "Rename this account" with an id in the body is the same
 * shape of vulnerability the socket join request is careful to avoid.
 */
export async function updateProfile(
  deps: IdentityDeps,
  userId: UserId,
  input: UpdateProfileInput,
): Promise<{ readonly displayName: string | null }> {
  const existing = await repo.findUserById(userId);
  if (existing === undefined) throw errors.notFound();

  /* Length is bounded here as well as by the CHECK constraint. The constraint
     is what cannot be bypassed; this is what turns an over-long name into a
     readable validation error instead of a 500 from a failed write. */
  if (input.displayName !== null && input.displayName.trim().length > 80) {
    throw errors.validation({ displayName: 'A name can be at most 80 characters.' });
  }

  const before = existing.displayName;
  const after = await repo.updateDisplayName(userId, input.displayName);

  /* No event when nothing changed. An entry in the compliance record for a save
     that wrote the same value is noise in the one log that should not have any,
     and it would wake every consumer for it. */
  if (before !== after) {
    await deps.events.publish([
      createEvent(
        identityEvents.displayNameChanged,
        { userId, before, after },
        { orgId: SYSTEM_ORG, actorId: userId, occurredAt: new Date() },
      ),
    ]);
  }

  return { displayName: after };
}
