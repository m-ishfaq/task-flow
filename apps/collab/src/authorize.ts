import { loadPage, pageTarget } from '@taskflow/api/docs/page';
import { resolveOrgMembership } from '@taskflow/api/tenancy/resolve';
import { withOrgScope } from '@taskflow/db';
import { can, type Decision, type Subject } from '@taskflow/policy';
import type { OrgId, PageId, UserId } from '@taskflow/contracts';

/**
 * Page connection authorization (ai/phase-6-docs.md §3.3, §3.4).
 *
 * ## This is not a second authorization path
 *
 * Every input below comes from the SAME functions the HTTP path uses —
 * `resolveOrgMembership` for the role and tuples, `loadPage`/`pageTarget` for
 * the page's org and its inheritance chain, `can()` for the decision —
 * imported from `@taskflow/api` rather than reimplemented. This is the
 * identical discipline `apps/realtime/src/rooms.ts` documents for board and
 * channel joins: a socket layer that grows its own notion of "who may see
 * this page" produces two models that drift, and the one users hit live is
 * the one nobody tests.
 *
 * ## Harder than a room join, on purpose
 *
 * A room-join in Phase 4 checks one flat resource. A page-open here checks a
 * resource whose authorization depends on walking the tree first — `loadPage`
 * already returns the row with `ancestorIds` populated, so `pageTarget` can
 * build the full nearest-first chain in one query, but the RESULT still has
 * to be treated as what it is: a resolved-from-the-tree decision, not a flat
 * one. Getting this wrong is a tenant or permission bypass exactly as serious
 * as anything on `apps/realtime`'s `auth.ts`/`rooms.ts` — see CLAUDE.md's
 * human-review-surfaces list, which this file joins the moment it exists.
 */

export interface ConnectAuthorization {
  readonly allowed: boolean;
  /** Whether writes must be rejected even though the connection is allowed. */
  readonly readOnly: boolean;
  /** The decision that produced the outcome, for the observability trail — absent when refused BEFORE one could be reached. */
  readonly decision?: Decision;
  readonly reason: 'granted' | 'denied' | 'not_a_member' | 'no_such_page';
}

/**
 * Decides whether `userId` may open `pageId` in `orgId`, and whether the
 * connection must be read-only.
 *
 * Refusal is REFUSAL, never a silent downgrade to read-only: a page the
 * caller cannot even read (`page:read` denied) gets the connection rejected
 * outright, the same "refused rather than silently downgraded" principle
 * Phase 4 §3.8 established for origin checking. Read-only is reserved for the
 * case where reading is allowed but writing is not.
 */
export async function authorizeConnect(
  userId: UserId,
  orgId: OrgId,
  pageId: PageId,
): Promise<ConnectAuthorization> {
  const membership = await resolveOrgMembership(userId, orgId);
  if (membership === null) return { allowed: false, readOnly: true, reason: 'not_a_member' };

  const page = await withOrgScope(orgId, async (tx) => {
    try {
      return await loadPage(tx, pageId);
    } catch {
      /* `loadPage` throws a tRPC NOT_FOUND. There is no HTTP response to
         shape here, and — as in `rooms.ts` — the distinction between "no such
         page" and "a page in another tenant" is one RLS has already erased. */
      return null;
    }
  });
  if (page === null) return { allowed: false, readOnly: true, reason: 'no_such_page' };

  const subject: Subject = {
    orgId: membership.orgId,
    userId,
    role: membership.role,
    tuples: membership.tuples,
  };
  const target = pageTarget(page);

  const readDecision = can(subject, 'page:read', target);
  if (!readDecision.allowed) {
    return { allowed: false, readOnly: true, decision: readDecision, reason: 'denied' };
  }

  const writeDecision = can(subject, 'page:update', target);

  return {
    allowed: true,
    readOnly: !writeDecision.allowed,
    decision: writeDecision.allowed ? writeDecision : readDecision,
    reason: 'granted',
  };
}
