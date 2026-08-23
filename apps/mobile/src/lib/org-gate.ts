import type { OrgId } from '@taskflow/contracts';

/**
 * The org gate, ported from apps/web's `OrgGate` (ai/phase-14-mobile.md §7).
 *
 * The selected org id is remembered between launches, and remembering it is not
 * the same as knowing it is still valid. The stored value outlives the session
 * that chose it — a second person signing in on the same device, a membership
 * revoked while the app was closed, or a reinstalled backend all leave an id
 * that names an org the current user is not in. If that stale id reached the
 * first org-scoped query, every request on the screen would answer
 * NOT_A_MEMBER, which reads as a broken app rather than a stale selection.
 *
 * So the remembered id is validated against the caller's real memberships —
 * `tenancy.orgs.list`, the one read that needs no org context — BEFORE any
 * org-scoped screen renders. This function is that check, kept pure so it is
 * unit-tested directly: the navigator awaits the membership list, calls this,
 * and routes to the org picker when it returns null.
 *
 * The org id itself is not a credential and confers nothing: it becomes the
 * attacker-controllable `x-taskflow-org` header, which is a WHERE filter against
 * the caller's own memberships and is never written to `app.org_id`. So it is
 * safe to persist in ordinary (non-secure) storage — the same reasoning
 * apps/web records for `localStorage`.
 */
export function resolveRememberedOrg(
  rememberedId: string | null,
  memberships: readonly { readonly id: OrgId }[],
): OrgId | null {
  if (rememberedId === null || rememberedId === '') return null;
  const match = memberships.find((m) => m.id === rememberedId);
  return match?.id ?? null;
}
