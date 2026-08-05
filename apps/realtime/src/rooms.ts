import { withOrgScope } from '@taskflow/db';
import { can, type Decision } from '@taskflow/policy';
import type { BoardId, OrgId, UserId } from '@taskflow/contracts';
import { resolveOrgMembership } from '@taskflow/api/tenancy/resolve';
import { loadBoard } from '@taskflow/api/work/board';

/**
 * Room authorization (ai/phase-4-realtime.md §3.3, §6.2).
 *
 * ## This is not a second authorization path
 *
 * Every input to the decision below is produced by the SAME functions the HTTP
 * path uses — `resolveOrgMembership` for the role and tuples, `loadBoard` for
 * the board's org and its project ancestor, `can()` for the decision — imported
 * from `@taskflow/api` rather than reimplemented. §6.2 is the rule §8.2 states
 * for the UI, aimed at the gateway: a socket layer that grows its own notion of
 * "who may see this board" produces two models that drift, and the one users hit
 * live is the one nobody tests.
 *
 * The deployment boundary between `apps/api` and `apps/realtime` is a process
 * boundary. It is deliberately not an authorization boundary.
 *
 * ## Why the decision is re-made on every join, and re-made again later
 *
 * A socket can stay in a room for hours, and a membership can change in that
 * window. The fix is NOT a TTL on this decision — a cache that expires is still
 * wrong for however long it has left. It is `revocation.ts`, which re-runs this
 * exact function for the affected sockets when the events that already exist for
 * this purpose arrive (`grant.revoked`, `member.role_changed`, `member.removed`).
 * That is why this is a plain function of `(userId, orgId, boardId)` with no
 * memoization: it has to be safe to call again at any moment.
 */

export interface JoinAuthorization {
  readonly allowed: boolean;
  /**
   * The full decision when one was reached, for the observability trail (§3.8).
   *
   * Absent when the caller failed BEFORE a decision could be made — no
   * membership in the named org, or no such board. Those are refusals without a
   * trace, and conflating them with a denial would put a misleading "role X does
   * not grant board:read" in the log for a user who is not in the org at all.
   */
  readonly decision?: Decision;
  /** Coarse reason, for logs. Never sent to the client — see `JoinRefusal`. */
  readonly reason: 'granted' | 'not_a_member' | 'no_such_board' | 'denied';
}

/**
 * Decides whether `userId` may join `board:{boardId}` in `orgId`.
 *
 * `userId` comes from `socket.data`, set once at the handshake from a verified
 * token (§3.7). It is never a value from the join request, and this function
 * takes it as a branded `UserId` so a raw string from a payload cannot be passed
 * without a parse that would have to be written deliberately.
 */
export async function authorizeJoin(
  userId: UserId,
  orgId: OrgId,
  boardId: BoardId,
): Promise<JoinAuthorization> {
  /* Membership first, and in `withUserScope` (inside `resolveOrgMembership`) —
     so the SCOPE comes from the verified token and the requested org is only a
     filter. Naming an org you are not in resolves to null here, exactly as it
     leaves `principal.org` null on the HTTP side. */
  const membership = await resolveOrgMembership(userId, orgId);
  if (membership === null) return { allowed: false, reason: 'not_a_member' };

  /* Now, and only now, is it safe to open an org scope on this id: the
     membership row proved the caller belongs to it. Same ordering as the HTTP
     path, and for the reason `resolve.ts` gives — putting an unverified value
     into the session variable the whole tenancy guarantee rests on is a pattern
     that stops being safe the moment someone copies it into a query that does
     more than one lookup. */
  const board = await withOrgScope(orgId, async (tx) => {
    try {
      return await loadBoard(tx, boardId);
    } catch {
      /* `loadBoard` throws a tRPC NOT_FOUND. There is no HTTP response to shape
         here, and the distinction between "no such board" and "a board in
         another tenant" is one RLS has already erased — a board outside this org
         is simply not in the rows this scope can see. */
      return null;
    }
  });

  if (board === null) return { allowed: false, reason: 'no_such_board' };

  const decision = can(
    {
      orgId: membership.orgId,
      userId,
      role: membership.role,
      tuples: membership.tuples,
    },
    'board:read',
    {
      /* The org from the BOARD ROW, not from the request — `Target.orgId` is
         documented as exactly that, and it is what makes layer 2a's cross-tenant
         check meaningful rather than a comparison of a value with itself. */
      orgId: board.orgId,
      resource: { type: 'board', id: boardId },
      /* The project ancestor, so a grant on the project reaches its boards —
         identical to what `listLists` passes on the HTTP side. Omitting it would
         silently refuse anyone whose access came from a project-level tuple. */
      ancestors: [{ type: 'project', id: board.projectId }],
    },
  );

  return decision.allowed
    ? { allowed: true, decision, reason: 'granted' }
    : { allowed: false, decision, reason: 'denied' };
}
