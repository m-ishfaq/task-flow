import { ROLES, type Role } from './roles.js';

/**
 * Rules about ASSIGNING roles, as opposed to what a role grants (PLAN.md §8.2).
 *
 * These live here for the same reason `roleGrants` does. Guardrail 7 makes
 * `role === 'owner'` a lint error outside this package, and the reason is not
 * tidiness: an inline comparison in a service is invisible to the matrix test,
 * so it keeps enforcing what the matrix has since changed. Membership
 * management is full of exactly those comparisons — "is this the last owner",
 * "may this role be handed out directly" — and every one of them is a policy
 * decision wearing a service's clothes.
 *
 * Separate from roles.ts because the questions are different in kind. That file
 * answers "what may someone with this role do"; this one answers "who is
 * allowed to hold it, and what breaks if nobody does".
 */

/**
 * The role an organization must never be left without.
 *
 * Losing the last one produces a tenant nobody can administer, recover, or
 * delete — the only fix is a database console. Both the demotion and the
 * removal path in the membership service check this before writing.
 *
 * Owner rather than Admin because Admin deliberately cannot manage members
 * (§8.2): an admin who could edit roles could promote themselves, which makes
 * the Owner/Admin split decorative.
 */
export function isIndispensableRole(role: Role): boolean {
  return role === 'owner';
}

/**
 * True when a role may be granted directly while adding someone to an org.
 *
 * Owner is excluded, so the top role is only ever reached by promoting an
 * existing member — a separate, step-up-protected operation. Otherwise one call
 * would both create a membership and grant everything, with no prior role for
 * the audit entry to record a change from, and "who made them an owner" would
 * have no before value to answer with.
 */
export function isDirectlyAssignable(role: Role): boolean {
  return role !== 'owner';
}

/** Roles that may be handed out by `members.add`. Exported for tests and UI. */
export const DIRECTLY_ASSIGNABLE_ROLES: readonly Role[] = ROLES.filter(isDirectlyAssignable);

/**
 * Whether two roles are the same.
 *
 * A trivial function, and it exists because guardrail 7 correctly cannot tell
 * `a === b` on two roles apart from `a === 'admin'`. Rather than teach the rule
 * an exception — which would then have to be maintained, and would be the
 * loophole anyone reaches for — role identity is simply another thing this
 * module owns.
 */
export function sameRole(left: Role, right: Role): boolean {
  return left === right;
}

/**
 * Whether a role is the Guest role — same trivial shape as `sameRole`, for
 * the same reason.
 *
 * Takes a plain `string`, unlike `sameRole`/`isIndispensableRole` — its one
 * caller (`work/guest-access.service.ts`) reads `role` straight off a
 * `memberships` row, which Drizzle types as `text` rather than the branded
 * `Role`, and there is nothing to validate-and-narrow first: an unrecognized
 * value here just isn't Guest, the same answer `false` already gives.
 *
 * Used outside `can()` entirely: Work's guest-invite flow refuses to grant a
 * project-level tuple to anyone whose MEMBERSHIP role is not already Guest,
 * which is a business rule about who this flow is FOR, not an authorization
 * decision — but the comparison itself is still `role === 'guest'` in shape,
 * so it belongs here rather than as an inline check the lint rule cannot
 * distinguish from a real, drifting authorization shortcut.
 */
export function isGuestRole(role: string): boolean {
  return role === 'guest';
}
